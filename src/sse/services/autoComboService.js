import {
  isAutoComboName,
  orderByRank,
  collectRankedAutoModels,
  classifyAutoError,
  getAutoCooldownMs,
  getModelState,
  buildAutoAttemptOrder,
  selectProbeCandidate,
  buildAutoProbeBody,
} from "open-sse/services/autoCombo.js";
import {
  getModelRanks,
  getAutoHealth,
  bumpAutoModelFailure,
  resetAutoModelFailure,
  getAutoLkgp,
  promoteAutoLkgp,
} from "@/lib/db/repos/autoComboRepo.js";
import { getProviderConnections, getCustomModels, getModelAliases } from "@/lib/db/index.js";
import { getDisabledModels } from "@/lib/db/repos/disabledModelsRepo.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { FREE_PROVIDERS, getProviderAlias } from "@/shared/constants/providers.js";

export { isAutoComboName, orderByRank, collectRankedAutoModels, classifyAutoError, getAutoCooldownMs, getModelState };

// Single probe in flight per model (process-local guard).
const probeInFlight = new Set();

export function getProbeInFlight() {
  return probeInFlight;
}

/**
 * Aliases backed by a live route: providers with an active connection, plus
 * no-auth free providers (served by the virtual public connection).
 */
export async function getActiveAutoAliases() {
  const out = new Set();
  const connections = await getProviderConnections().catch(() => []);
  for (const conn of connections || []) {
    if (conn?.isActive === false) continue;
    const providerId = conn?.provider;
    if (!providerId) continue;
    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    out.add(providerId);
    out.add(staticAlias);
    const prefix = conn?.providerSpecificData?.prefix;
    const outputAlias = String(prefix || getProviderAlias(providerId) || staticAlias).trim();
    if (outputAlias) out.add(outputAlias);
  }
  for (const [id, p] of Object.entries(FREE_PROVIDERS || {})) {
    if (!p?.noAuth) continue;
    out.add(id);
    out.add(PROVIDER_ID_TO_ALIAS[id] || id);
    if (p.alias) out.add(p.alias);
  }
  return out;
}

/**
 * Available LLM `alias/model` ids from active connections without live network
 * fetches: static catalog filtered by explicit enabledModels, plus custom
 * models and aliases. Mirrors the offline branch of buildModelsList.
 *
 * `liveModels` lets a caller supply a runtime-discovered catalog (e.g. the
 * advertised list from buildModelsList); those IDs count as registered only
 * when their provider alias is active.
 */
export async function getAvailableAutoModels({ liveModels = [] } = {}) {
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter((c) => c.isActive !== false);
  } catch {
    return [];
  }
  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch {
    customModels = [];
  }
  let aliases = {};
  try {
    aliases = await getModelAliases();
  } catch {
    aliases = {};
  }

  const seen = new Map();
  const activeByProvider = new Map();
  for (const conn of connections) {
    if (!activeByProvider.has(conn.provider)) activeByProvider.set(conn.provider, conn);
  }
  const activeAliases = await getActiveAutoAliases().catch(() => new Set());

  for (const [providerId, conn] of activeByProvider.entries()) {
    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const outputAlias = (
      conn?.providerSpecificData?.prefix
      || getProviderAlias(providerId)
      || staticAlias
    ).trim();
    const staticModels = PROVIDER_MODELS[staticAlias] || [];
    const enabled = conn?.providerSpecificData?.enabledModels;
    const ids = Array.isArray(enabled) && enabled.length > 0
      ? enabled.filter((m) => typeof m === "string" && m.trim() !== "")
      : staticModels.map((m) => m.id);
    for (let id of ids) {
      if (id.startsWith(`${outputAlias}/`)) id = id.slice(outputAlias.length + 1);
      else if (id.startsWith(`${staticAlias}/`)) id = id.slice(staticAlias.length + 1);
      else if (id.startsWith(`${providerId}/`)) id = id.slice(providerId.length + 1);
      if (!id) continue;
      seen.set(`${outputAlias}/${id}`, true);
    }
  }

  // Custom + alias targets only route when their provider has an active
  // connection; disconnected entries must not enter the pool.
  for (const m of customModels || []) {
    if (!m?.id || !m?.providerAlias) continue;
    if (m.type && m.type !== "llm") continue;
    if (!activeAliases.has(m.providerAlias)) continue;
    seen.set(`${m.providerAlias}/${String(m.id).trim()}`, true);
  }

  for (const full of Object.values(aliases || {})) {
    if (typeof full !== "string" || !full.includes("/")) continue;
    if (!activeAliases.has(full.slice(0, full.indexOf("/")))) continue;
    seen.set(full, true);
  }

  // Runtime-discovered catalog membership: an ID is accepted only when its
  // provider alias is active and it is a well-formed `alias/model`.
  for (const full of Array.isArray(liveModels) ? liveModels : []) {
    if (typeof full !== "string") continue;
    const key = full.trim();
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) continue;
    if (!activeAliases.has(key.slice(0, slash))) continue;
    seen.set(key, true);
  }

  return [...seen.keys()];
}

export async function getAutoRankedModels(options = {}) {
  const liveModels = Array.isArray(options?.liveModels) ? options.liveModels : [];
  const [ranks, disabledByAlias, available] = await Promise.all([
    getModelRanks().catch(() => ({})),
    getDisabledModels().catch(() => ({})),
    getAvailableAutoModels({ liveModels }).catch(() => []),
  ]);
  const disabled = new Set();
  for (const [alias, ids] of Object.entries(disabledByAlias || {})) {
    for (const id of ids || []) disabled.add(`${alias}/${id}`);
  }
  // Membership is authoritative: a ranked model routes only if it is present in
  // the registered/enabled/live-discovered set. A mistyped arbitrary ranked ID
  // that merely shares an active provider prefix is excluded.
  for (const m of available) {
    const slash = m.indexOf("/");
    if (slash > 0) {
      const alias = m.slice(0, slash);
      const id = m.slice(slash + 1);
      if (Array.isArray(disabledByAlias?.[alias]) && disabledByAlias[alias].includes(id)) {
        disabled.add(m);
      }
    }
  }
  return collectRankedAutoModels(available, ranks, disabled);
}

/**
 * Auto/Smart request path with LKGP + per-model circuit breaker.
 * Transient-only fallback; auth/config errors stop after persisting
 * config-error state (never fall back); open circuits are never retried.
 *
 * State access is injectable via `deps` (defaults hit the real stores) so the
 * routing logic is testable without a database or upstream providers.
 */
export async function handleAutoComboChat({ body, handleSingleModel, log, comboName = "auto", deps = {} }) {
  const {
    loadRanked = getAutoRankedModels,
    loadHealth = getAutoHealth,
    loadLkgp = getAutoLkgp,
    noteFailure = (model) => bumpAutoModelFailure(model, Date.now()),
    noteSuccess = (model) => resetAutoModelFailure(model),
    noteLkgp = promoteAutoLkgp,
    disableModel = disableAutoModel,
    buildProbeBody = buildAutoProbeBody,
    now = () => Date.now(),
  } = deps;

  const ranked = await loadRanked();
  if (!ranked || ranked.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: `Auto combo "${comboName}" has no ranked models. Assign intelligence ranks first.` } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const [health, lkgp] = await Promise.all([
    loadHealth().catch(() => ({})),
    loadLkgp().catch(() => null),
  ]);
  const nowMs = now();
  const order = buildAutoAttemptOrder(ranked, health, lkgp, nowMs, probeInFlight);

  // Fire one guarded lightweight recovery probe for an expired failed model.
  // This runs even when the main attempt order is empty (every circuit expired)
  // so an all-cooling pool can still recover. The probe lock is pool-scoped
  // (shared by auto/smart), so only one probe runs pool-wide at a time. The
  // current request is answered safely below without sending it to a failed model.
  const probeModel = selectProbeCandidate(ranked, health, lkgp, nowMs, probeInFlight);
  if (probeModel) {
    probeInFlight.add(probeModel);
    const probeBody = buildProbeBody(body);
    Promise.resolve()
      .then(() => handleSingleModel(probeBody, probeModel))
      .then(async (res) => {
        if (res?.ok) {
          await noteSuccess(probeModel).catch(() => {});
          await noteLkgp(probeModel).catch(() => {});
          log?.info?.("AUTO", `probe ${probeModel} ok → LKGP restored`);
        } else {
          let text = "";
          try {
            const j = await res?.clone?.()?.json?.();
            text = j?.error?.message || j?.error || "";
          } catch { /* ignore */ }
          const cls = classifyAutoError({ status: res?.status, errorText: text });
          if (cls.action === "fallback") {
            await noteFailure(probeModel).catch(() => {});
          } else if (cls.action === "config-error") {
            await disableModel(probeModel).catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => probeInFlight.delete(probeModel));
  }

  if (order.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: `No healthy auto model available (all ${ranked.length} in cooldown); recovery probe started.` } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  let lastError = null;
  let lastStatus = 503;

  for (const model of order) {
    log?.info?.("AUTO", `Trying ${model} (combo "${comboName}")`);
    let result;
    try {
      result = await handleSingleModel(body, model);
    } catch (e) {
      const cls = classifyAutoError({ status: 0, errorText: e?.message || String(e) });
      if (cls.action !== "fallback") {
        return new Response(
          JSON.stringify({ error: { message: e?.message || String(e) } }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }
      lastError = e?.message || String(e);
      lastStatus = 502;
      await noteFailure(model).catch(() => {});
      continue;
    }

    if (result?.ok) {
      await noteSuccess(model).catch(() => {});
      await noteLkgp(model).catch(() => {});
      return result;
    }

    let errorText = result?.statusText || "";
    try {
      const j = await result?.clone?.()?.json?.();
      errorText = j?.error?.message || j?.error || j?.message || errorText;
    } catch { /* ignore */ }
    if (typeof errorText !== "string") {
      try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
    }

    const cls = classifyAutoError({ status: result?.status, errorText });
    if (cls.action === "config-error") {
      // Non-transient: persist disabled state, then stop with the original error.
      log?.warn?.("AUTO", `Model ${model} config-error, disabling from retries`, { status: result?.status });
      await disableModel(model).catch(() => {});
      return result;
    }
    if (cls.action !== "fallback") {
      return result;
    }

    lastError = errorText || String(result?.status);
    lastStatus = result?.status || 503;
    await noteFailure(model).catch(() => {});
    log?.warn?.("AUTO", `Model ${model} failed, trying next`, { status: result?.status });
  }

  return new Response(
    JSON.stringify({ error: { message: lastError || "All auto models unavailable" } }),
    { status: lastStatus, headers: { "Content-Type": "application/json" } }
  );
}

async function disableAutoModel(model) {
  const { disableModels } = await import("@/lib/db/repos/disabledModelsRepo.js");
  const slash = model.indexOf("/");
  if (slash > 0) {
    await disableModels(model.slice(0, slash), [model.slice(slash + 1)]).catch(() => {});
  }
}
