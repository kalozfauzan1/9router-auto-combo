import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getAutoCooldownMs, shouldPromoteLkgp } from "open-sse/services/autoCombo.js";

// Manual intelligence ranking persisted as model configuration.
// Single kv entry: scope `modelRanks`, key `ranks` -> { "provider/model": rankNumber }.
const rankKv = makeKv("modelRanks");
const RANKS_KEY = "ranks";

// Runtime health persisted separately from ranking.
// Scope `autoComboHealth`: key = model string -> { failures, cooldownUntil }.
const healthKv = makeKv("autoComboHealth");

// LKGP persisted separately from ranking.
// Scope `autoComboState`: key `lkgp` -> { model, updatedAt }.
const stateKv = makeKv("autoComboState");
const LKGP_KEY = "lkgp";

function sanitizeRanks(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === "number" ? v : Number(v);
    if (typeof k === "string" && k.includes("/") && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export async function getModelRanks() {
  const raw = await rankKv.get(RANKS_KEY, {});
  return sanitizeRanks(raw);
}

export async function setModelRanks(ranks) {
  const clean = sanitizeRanks(ranks);
  await rankKv.set(RANKS_KEY, clean);
  return clean;
}

export async function setModelRank(model, rank) {
  const current = await getModelRanks();
  const n = typeof rank === "number" ? rank : Number(rank);
  if (typeof model !== "string" || !model.includes("/") || !Number.isFinite(n)) {
    return current;
  }
  const next = { ...current, [model]: n };
  await rankKv.set(RANKS_KEY, next);
  return next;
}

export async function deleteModelRank(model) {
  const current = await getModelRanks();
  if (!(model in current)) return current;
  const next = { ...current };
  delete next[model];
  await rankKv.set(RANKS_KEY, next);
  return next;
}

export async function getAutoHealth() {
  const all = await healthKv.getAll();
  const out = {};
  for (const [k, v] of Object.entries(all || {})) {
    if (typeof k !== "string" || !k.includes("/")) continue;
    const failures = Number(v?.failures) || 0;
    const cooldownUntil = Number(v?.cooldownUntil) || 0;
    out[k] = { failures, cooldownUntil };
  }
  return out;
}

export async function setAutoModelHealth(model, { failures = 0, cooldownUntil = 0 } = {}) {
  if (typeof model !== "string" || !model.includes("/")) return await getAutoHealth();
  await healthKv.set(model, {
    failures: Number(failures) || 0,
    cooldownUntil: Number(cooldownUntil) || 0,
  });
  return await getAutoHealth();
}

export async function clearAutoHealth() {
  await healthKv.clear();
  return {};
}

/**
 * Increment a model's consecutive-failure count and set a fixed 5m cooldown.
 * Read-modify-write runs inside one synchronous DB transaction, so concurrent
 * failure reports cannot collapse into one.
 */
export async function bumpAutoModelFailure(model, nowMs = Date.now()) {
  if (typeof model !== "string" || !model.includes("/")) return await getAutoHealth();
  const now = Number(nowMs) || Date.now();
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, ["autoComboHealth", model]);
    const prev = row ? parseJson(row.value, null) : null;
    const failures = (Number(prev?.failures) || 0) + 1;
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      ["autoComboHealth", model, stringifyJson({ failures, cooldownUntil: now + getAutoCooldownMs(failures) })]
    );
  });
  return await getAutoHealth();
}

/** Clear a single model's failure state (success path). Single blind-safe write. */
export async function resetAutoModelFailure(model) {
  if (typeof model !== "string" || !model.includes("/")) return await getAutoHealth();
  await healthKv.set(model, { failures: 0, cooldownUntil: 0 });
  return await getAutoHealth();
}

export async function getAutoLkgp() {
  const raw = await stateKv.get(LKGP_KEY, null);
  const model = raw?.model;
  return typeof model === "string" && model.includes("/") ? model : null;
}

export async function setAutoLkgp(model) {
  if (typeof model !== "string" || !model.includes("/")) return await getAutoLkgp();
  await stateKv.set(LKGP_KEY, { model, updatedAt: Date.now() });
  return model;
}

/**
 * Rank-aware LKGP promotion, serialized in one synchronous DB transaction.
 * A lower-ranked success never overwrites a higher-ranked one, so a main-path
 * fallback success cannot clobber a concurrent higher-ranked probe success.
 */
export async function promoteAutoLkgp(model) {
  if (typeof model !== "string" || !model.includes("/")) return await getAutoLkgp();
  const db = await getAdapter();
  db.transaction(() => {
    const rankRow = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, ["modelRanks", RANKS_KEY]);
    const ranks = sanitizeRanks(rankRow ? parseJson(rankRow.value, {}) : {});
    const lkgpRow = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, ["autoComboState", LKGP_KEY]);
    const current = lkgpRow ? parseJson(lkgpRow.value, null)?.model : null;
    if (!shouldPromoteLkgp(ranks, model, current)) return;
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      ["autoComboState", LKGP_KEY, stringifyJson({ model, updatedAt: Date.now() })]
    );
  });
  return await getAutoLkgp();
}

export async function clearAutoLkgp() {
  await stateKv.remove(LKGP_KEY);
  return null;
}
