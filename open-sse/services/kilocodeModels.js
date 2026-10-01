/**
 * Kilo live model catalog fetcher.
 *
 * Kilo Code proxies the OpenRouter catalog, so the 8 hardcoded models in
 * `providers/registry/kilocode.js` are only a fallback. This module fetches
 * the live gateway catalog (`/api/gateway/models`, OpenRouter-shaped) and
 * returns chat-capable entries as `{ id, name }` pairs.
 *
 * Fail-open by design: any fetch/parse failure returns null so callers fall
 * back to the static registry list. Results are cached in-memory (10 min);
 * a stale cache is served immediately while a background refresh runs, so
 * the auto-combo chat hot path never blocks on this fetch.
 */

export const KILOCODE_GATEWAY_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @type {{ models: Array<{ id: string, name: string }>, fetchedAt: number } | null} */
let catalogCache = null;
/** In-flight fetch shared by concurrent callers. */
let inflight = null;

/** Test seam: drop the cached catalog. */
export function clearKilocodeCatalogCache() {
  catalogCache = null;
  inflight = null;
}

// Model ids in the gateway catalog keep their upstream `vendor/model` shape
// (e.g. `cohere/north-mini-code:free`). Media models never belong in the LLM
// candidate list, mirroring `inferKindFromUnknownModelId` in
// `src/app/api/v1/models/route.js` (which defaults unknown ids to LLM).
const NON_CHAT_ID_HINTS = [
  /embed/i,
  /tts|speech|voice|audio/i,
  /image|imagen|dall-?e|flux|sdxl|stable-diffusion/i,
  /\bvideo\b|veo|sora/i,
];

function isChatModelId(id) {
  const text = String(id || "");
  if (!text) return false;
  return !NON_CHAT_ID_HINTS.some((re) => re.test(text));
}

function normalizeCatalog(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const entry of list) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || !isChatModelId(id)) continue;
    out.push({ id, name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : id });
  }
  return out;
}

async function fetchCatalog({ timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(KILOCODE_GATEWAY_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res?.ok) return null;
    const json = await res.json().catch(() => null);
    const raw = json?.data ?? json?.models ?? json;
    const models = normalizeCatalog(raw);
    return models.length > 0 ? { models } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function refreshInBackground(options) {
  if (inflight) return inflight;
  inflight = fetchCatalog(options)
    .then((result) => {
      if (result) catalogCache = { ...result, fetchedAt: Date.now() };
      return result;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Resolve the live Kilo chat-model catalog.
 * - Fresh cache (10 min): returned immediately, no network.
 * - Stale cache: returned immediately + background refresh (never blocks).
 * - Cold cache: fetched with a 5s timeout; null on any failure.
 *
 * @returns {Promise<{ models: Array<{ id: string, name: string }> } | null>}
 */
export async function resolveKilocodeModels(options = {}) {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CACHE_TTL_MS) {
    return { models: catalogCache.models };
  }
  if (catalogCache) {
    // Stale-while-revalidate: serve stale, refresh without blocking.
    refreshInBackground(options).catch(() => {});
    return { models: catalogCache.models };
  }
  const result = await refreshInBackground(options).catch(() => null);
  return result;
}
