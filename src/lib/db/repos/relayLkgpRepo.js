import { makeKv } from "../helpers/kvStore.js";
import { nextFailStreak } from "open-sse/services/relayHealth.js";

// Last-known-good provider per provider+model. The wildcard key (`*`) covers
// requests that do not target a specific model.
const lkgpKv = makeKv("relayLkgp");

// Per-connection relay health, tracked separately for each model lane.
const healthKv = makeKv("relayHealth");

function isId(value) {
  return typeof value === "string" && value.length > 0;
}

function entryKey(id, model) {
  return `${id}:${model || "*"}`;
}

function timestamp(now) {
  const value = Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function asEntry(raw) {
  return raw && typeof raw === "object" ? raw : null;
}

function asEntryMap(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const entry = asEntry(value);
    if (entry) out[key] = entry;
  }
  return out;
}

/**
 * @param {string} providerId
 * @param {string} [model]
 * @returns {Promise<{ connectionId: string, updatedAt: number, hits: number }|null>}
 */
export async function getRelayLkgp(providerId, model) {
  if (!isId(providerId)) return null;
  return asEntry(await lkgpKv.get(entryKey(providerId, model), null));
}

/**
 * @param {string} providerId
 * @param {string} [model]
 * @param {string} connectionId
 * @param {number} [now]
 * @returns {Promise<{ connectionId: string, updatedAt: number, hits: number }|null>}
 */
export async function setRelayLkgp(providerId, model, connectionId, now = Date.now()) {
  if (!isId(providerId) || !isId(connectionId)) return null;

  const key = entryKey(providerId, model);
  const prev = asEntry(await lkgpKv.get(key, null));
  const hits = prev?.connectionId === connectionId ? (Number(prev.hits) || 0) + 1 : 1;
  const entry = { connectionId, updatedAt: timestamp(now), hits };

  await lkgpKv.set(key, entry);
  return entry;
}

/**
 * @param {string} providerId
 * @param {string} [model]
 * @param {string|null} [connectionId] - When provided, only clear if it still matches.
 * @returns {Promise<boolean>} Whether an entry was removed.
 */
export async function clearRelayLkgp(providerId, model, connectionId = null) {
  if (!isId(providerId)) return false;

  const key = entryKey(providerId, model);
  const prev = asEntry(await lkgpKv.get(key, null));
  if (!prev) return false;
  if (connectionId != null && prev.connectionId !== connectionId) return false;

  await lkgpKv.remove(key);
  return true;
}

/**
 * @param {string} connectionId
 * @param {string} [model]
 * @returns {Promise<object|null>}
 */
export async function getRelayHealth(connectionId, model) {
  if (!isId(connectionId)) return null;
  return asEntry(await healthKv.get(entryKey(connectionId, model), null));
}

/**
 * Read the health of every candidate connection for one model lane.
 *
 * Pool-wide entries (`<connectionId>:*`) are merged in last, so a quota block
 * recorded on one model lane applies to every other lane of the same relay.
 *
 * @param {string} [model]
 * @param {string[]} [connectionIds] - Restrict to these connections when provided.
 * @returns {Promise<Record<string, object>>}
 */
export async function getRelayHealthForModel(model, connectionIds) {
  const all = await healthKv.getAll();
  const suffix = `:${model || "*"}`;
  const allowed = connectionIds == null
    ? null
    : new Set(Array.isArray(connectionIds) ? connectionIds : []);

  const out = {};
  for (const [key, value] of Object.entries(all || {})) {
    if (typeof key !== "string" || !key.endsWith(suffix)) continue;
    if (key.length === suffix.length) continue;

    const connectionId = key.slice(0, key.length - suffix.length);
    if (allowed && !allowed.has(connectionId)) continue;
    out[connectionId] = value;
  }

  const now = Date.now();
  for (const [key, value] of Object.entries(all || {})) {
    if (typeof key !== "string" || !key.endsWith(":*")) continue;
    // Only an active pool-wide block changes another lane's health; idle
    // wildcard entries (e.g. a cleared quota) must stay invisible.
    if (!(Number(value?.cooldownUntil) > now)) continue;
    const connectionId = key.slice(0, key.length - 2);
    if (!connectionId) continue;
    if (allowed && !allowed.has(connectionId)) continue;
    out[connectionId] = mergeHealthEntries(out[connectionId], value);
  }

  return out;
}

/**
 * Keep whichever entry holds the later deadline; the model lane wins a tie.
 *
 * @param {object|undefined} laneEntry
 * @param {object|undefined} poolEntry
 * @returns {object|undefined}
 */
function mergeHealthEntries(laneEntry, poolEntry) {
  if (!laneEntry) return poolEntry;
  if (!poolEntry) return laneEntry;
  const laneUntil = Number(laneEntry.cooldownUntil) || 0;
  const poolUntil = Number(poolEntry.cooldownUntil) || 0;
  return poolUntil > laneUntil ? poolEntry : laneEntry;
}

/**
 * Record a relay failure. `identityFail` is carried over from the previous
 * entry; only identity-specific failures increment it.
 *
 * @param {string} connectionId
 * @param {string} [model]
 * @param {{ errorClass?: string, cooldownMs?: number, now?: number, scope?: "model"|"pool" }} [options]
 *   `scope: "pool"` records the failure under the shared `<id>:*` key so it
 *   applies to every model lane of that relay (used for hard quota rejections).
 * @returns {Promise<object|null>}
 */
export async function bumpRelayFailure(connectionId, model, { errorClass = "transient", cooldownMs = 0, now = Date.now(), scope = "model" } = {}) {
  if (!isId(connectionId)) return null;

  const key = scope === "pool" ? entryKey(connectionId, "*") : entryKey(connectionId, model);
  const prev = asEntry(await healthKv.get(key, null));
  const at = timestamp(now);
  const cooldown = Number(cooldownMs);
  const entry = {
    failStreak: nextFailStreak(prev?.failStreak, at, prev?.lastFailureAt),
    lastFailureAt: at,
    lastSuccessAt: Number(prev?.lastSuccessAt) || 0,
    cooldownUntil: at + (Number.isFinite(cooldown) ? cooldown : 0),
    identityFail: Number(prev?.identityFail) || 0,
    errorClass,
  };

  await healthKv.set(key, entry);
  return entry;
}

/**
 * Record an identity failure without touching the transient failure streak or
 * any existing cooldown.
 *
 * @param {string} connectionId
 * @param {string} [model]
 * @param {number} [now]
 * @returns {Promise<object|null>}
 */
export async function noteRelayIdentityFail(connectionId, model, now = Date.now()) {
  if (!isId(connectionId)) return null;

  const key = entryKey(connectionId, model);
  const prev = asEntry(await healthKv.get(key, null));
  const entry = {
    failStreak: Number(prev?.failStreak) || 0,
    lastFailureAt: timestamp(now),
    lastSuccessAt: Number(prev?.lastSuccessAt) || 0,
    cooldownUntil: Number(prev?.cooldownUntil) || 0,
    identityFail: (Number(prev?.identityFail) || 0) + 1,
    errorClass: prev?.errorClass ?? null,
  };

  await healthKv.set(key, entry);
  return entry;
}

/**
 * @param {string} connectionId
 * @param {string} [model]
 * @param {number} [now]
 * @returns {Promise<object|null>}
 */
export async function resetRelayHealth(connectionId, model, now = Date.now()) {
  if (!isId(connectionId)) return null;

  const entry = {
    failStreak: 0,
    lastFailureAt: 0,
    lastSuccessAt: timestamp(now),
    cooldownUntil: 0,
    identityFail: 0,
    errorClass: null,
  };

  const key = entryKey(connectionId, model);
  const poolKey = entryKey(connectionId, "*");
  await healthKv.set(key, entry);
  // A success proves the relay's quota is back, so a pool-wide block recorded
  // by another model lane must not outlive it. Never create the shared key on
  // success: only remove one that a quota rejection actually wrote.
  if (key !== poolKey && asEntry(await healthKv.get(poolKey, null))) {
    await healthKv.remove(poolKey);
  }
  return entry;
}

export async function clearAllRelayHealth() {
  await healthKv.clear();
}

export async function clearAllRelayLkgp() {
  await lkgpKv.clear();
}

/**
 * Every stored relay LKGP entry, keyed by `providerId:model`.
 *
 * @returns {Promise<Record<string, object>>}
 */
export async function getAllRelayLkgp() {
  return asEntryMap(await lkgpKv.getAll());
}

/**
 * Every stored relay health entry, keyed by `connectionId:model`.
 *
 * @returns {Promise<Record<string, object>>}
 */
export async function getAllRelayHealth() {
  return asEntryMap(await healthKv.getAll());
}
