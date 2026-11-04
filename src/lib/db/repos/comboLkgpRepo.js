import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { nextComboFailure } from "../../../../open-sse/services/comboHealth.js";

// Persistent combo-level LKGP (Last Known Good Provider/Model).
// Scope `comboState`, key `lkgp:<comboName>` → { model, updatedAt }.
// Mirrors the auto pool's LKGP but scoped per combo and gated by
// settings.comboStrategies.<comboName>.lkgpEnabled.
const comboStateKv = makeKv("comboState");

// Serialize read/modify/write across factories sharing a store. This is an
// in-process guarantee; multiple server processes require a DB-level CAS.
const storeQueues = new WeakMap();
function serialize(store, key, mutation) {
  let queues = storeQueues.get(store);
  if (!queues) storeQueues.set(store, queues = new Map());
  const result = (queues.get(key) || Promise.resolve()).then(mutation);
  const settled = result.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return result;
}

/** KV keys are per tuple, never a whole-combo map. Revision tokens must be
 * captured before dispatch; a stale success cannot erase a later failure. */
export function createComboHealthRepo({ store = comboStateKv } = {}) {
  const keyFor = (combo, member) => `health:${JSON.stringify([combo, member])}`;
  const read = (key) => store.get(key, { failures: 0, version: 0 });
  return {
    async getHealth(combo, members) {
      return Object.fromEntries(await Promise.all(members.map(async (member) => [member, await read(keyFor(combo, member))])));
    },
    beginAttempt(combo, member) {
      const key = keyFor(combo, member);
      return serialize(store, `lkgp:${combo}`, async () => ({
        version: (await read(key)).version || 0,
        generation: (await store.get(`lkgp:${combo}`, null))?.generation || 0,
      }));
    },
    recordFailure(combo, member, options = {}) {
      const key = keyFor(combo, member);
      return serialize(store, key, async () => {
        const previous = await read(key);
        const next = { ...nextComboFailure(previous, options), version: (previous.version || 0) + 1 };
        await store.set(key, next);
        return next;
      });
    },
    recordSuccess(combo, member, attempt) {
      const key = keyFor(combo, member);
      return serialize(store, key, async () => {
        const previous = await read(key);
        if (!attempt || attempt.version !== (previous.version || 0)) return false;
        await store.set(key, { failures: 0, cooldownUntil: 0, version: (previous.version || 0) + 1 });
        return true;
      });
    },
    async getPin(combo) { return (await store.get(`lkgp:${combo}`, null))?.model ?? null; },
    setPin(combo, model, attempt, options = {}) {
      const key = `lkgp:${combo}`;
      return serialize(store, key, async () => {
        const previous = await store.get(key, null);
        const generation = previous?.generation || 0;
        // Health acceptance is member-scoped; pin promotion is combo-scoped.
        // Manual priority outranks generation: a recovery probe may have begun
        // before a later lower-priority success moved the pin, so an earlier
        // member wins even with a stale generation. A stale lower-priority
        // success never overwrites a higher-priority pin. Without member order,
        // keep the strict generation guard.
        if (attempt && attempt.generation !== generation) {
          const order = options?.members;
          if (!Array.isArray(order) || !model || !previous?.model) return false;
          const nextIndex = order.indexOf(model);
          const previousIndex = order.indexOf(previous.model);
          if (nextIndex < 0 || previousIndex < 0 || nextIndex >= previousIndex) return false;
        }
        await store.set(key, { model, updatedAt: Date.now(), generation: generation + 1 });
        return true;
      });
    },
  };
}

export async function getComboLkgp(comboName) {
  if (typeof comboName !== "string" || comboName.trim() === "") return null;
  const raw = await comboStateKv.get(`lkgp:${comboName}`, null);
  const model = raw?.model;
  return typeof model === "string" && model.includes("/") ? model : null;
}

export async function setComboLkgp(comboName, model) {
  if (typeof comboName !== "string" || comboName.trim() === "") return null;
  if (typeof model !== "string" || !model.includes("/")) return await getComboLkgp(comboName);
  await comboStateKv.set(`lkgp:${comboName}`, { model, updatedAt: Date.now() });
  return model;
}

export async function clearComboLkgp(comboName) {
  if (typeof comboName !== "string" || comboName.trim() === "") return null;
  await comboStateKv.remove(`lkgp:${comboName}`);
  return null;
}

export async function getAllComboLkgp() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? AND key LIKE 'lkgp:%'`, ["comboState"]);
  const out = {};
  for (const r of rows) {
    const parsed = parseJson(r.value, null);
    const name = r.key.slice("lkgp:".length);
    if (parsed?.model && typeof parsed.model === "string" && parsed.model.includes("/")) {
      out[name] = parsed.model;
    }
  }
  return out;
}
