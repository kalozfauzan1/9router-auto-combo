import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Persistent combo-level LKGP (Last Known Good Provider/Model).
// Scope `comboState`, key `lkgp:<comboName>` → { model, updatedAt }.
// Mirrors the auto pool's LKGP but scoped per combo and gated by
// settings.comboStrategies.<comboName>.lkgpEnabled.
const comboStateKv = makeKv("comboState");

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
