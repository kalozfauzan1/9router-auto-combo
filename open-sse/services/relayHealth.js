/**
 * Pure relay-health helpers.
 *
 * No app imports, no I/O, and no implicit clock reads: callers pass `now`
 * explicitly so classification, cooldowns, and ordering stay deterministic.
 */

/**
 * Classify a relay failure by HTTP status and upstream error text.
 *
 * @param {number} status - Upstream HTTP status.
 * @param {string} [errorText] - Upstream error body/message.
 * @returns {"transient"|"quota"|"ip-quarantine"|"credential"|"identity"|"model-lane"|"request"}
 */
export function classifyRelayError(status, errorText) {
  const text = typeof errorText === "string" ? errorText.toLowerCase() : "";

  if (text.includes("abusive traffic")) return "ip-quarantine";

  if (
    text.includes("can only be used from within opencode") ||
    (text.includes("free tier") && text.includes("opencode"))
  ) {
    return "identity";
  }

  // Hard quota rejection: the free lane is spent for this identity until a
  // stated deadline. Keeping it out of the transient 429 lane is what stops a
  // relay from being re-probed every backoff tick while it is still exhausted.
  if (isQuotaErrorText(text)) return "quota";

  if (status === 404 || status === 410) return "model-lane";
  if (status === 400 || status === 422) return "request";
  if (status === 401 || status === 402) return "credential";
  if (status === 429) return "transient";
  if (status >= 500) return "transient";

  return "transient";
}

/**
 * Compute a cooldown for an error class. No jitter is applied here.
 *
 * Streaks above the first double the cooldown; the exponent is clamped to 10
 * so a large streak cannot overflow before the cap is applied.
 *
 * @param {string} errorClass - Value returned by {@link classifyRelayError}.
 * @param {number} failStreak - Consecutive failures, including the current one.
 * @param {object} [config] - Optional cooldown overrides.
 * @returns {number} Cooldown in milliseconds.
 */
export function relayCooldownMs(errorClass, failStreak, config = {}) {
  const cfg = config || {};

  switch (errorClass) {
    case "request":
    case "identity":
    case "model-lane":
      return 0;
    case "credential":
      return cfg.credentialMs ?? 1_800_000;
    case "quota":
      // Floor only; the real deadline comes from Retry-After via quotaCooldownMs().
      return cfg.quotaMs ?? 900_000;
    case "ip-quarantine":
      return scaledCooldown(cfg.ipQuarantineMs ?? 1_800_000, cfg.ipQuarantineMaxMs ?? 3_600_000, failStreak);
    case "transient":
      return scaledCooldown(cfg.transientMs ?? 30_000, cfg.transientMaxMs ?? 300_000, failStreak);
    default:
      return 0;
  }
}

/**
 * Upstream wording that means "the free quota for this identity is spent",
 * as opposed to "slow down for a moment".
 */
const QUOTA_ERROR_MARKERS = [
  "free usage limit",
  "freeusagelimiterror",
  "subscribe to opencode go",
  "go usage limit",
  "go_usage_limit",
  "usage_limit_reached",
];

/**
 * @param {string} errorText - Upstream error text, any case.
 * @returns {boolean}
 */
export function isQuotaErrorText(errorText) {
  const text = typeof errorText === "string" ? errorText.toLowerCase() : "";
  if (!text) return false;
  return QUOTA_ERROR_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Parse an upstream `Retry-After` header into a duration.
 * Both RFC 9110 forms are accepted: delta-seconds and HTTP-date.
 *
 * @param {string|number|null|undefined} value
 * @param {number} [now] - Current epoch milliseconds.
 * @returns {number|null} Duration in milliseconds, or null when unusable.
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const at = Date.parse(raw);
  const base = Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(base)) return null;
  return Math.max(at - base, 0);
}

/**
 * Cooldown for a hard quota rejection.
 *
 * The upstream deadline wins when it is known; otherwise a floor long enough
 * to stop the probe storm is used. Always capped, so a pool is never parked
 * longer than the caller allows.
 *
 * @param {object} [options]
 * @param {number|null} [options.retryAfterMs]
 * @param {number|null} [options.resetsAtMs]
 * @param {number} [options.now]
 * @param {object} [options.config]
 * @returns {number} Cooldown in milliseconds.
 */
export function quotaCooldownMs({ retryAfterMs = null, resetsAtMs = null, now = Date.now(), config = {} } = {}) {
  const cfg = config || {};
  const base = positiveMs(cfg.quotaMs, 900_000);
  const min = positiveMs(cfg.quotaMinMs, 60_000);
  const max = positiveMs(cfg.quotaMaxMs, 6 * 60 * 60 * 1000);

  const declared = [];
  const retry = Number(retryAfterMs);
  if (Number.isFinite(retry) && retry > 0) declared.push(retry);
  const reset = Number(resetsAtMs);
  if (Number.isFinite(reset) && reset > Number(now)) declared.push(reset - Number(now));

  if (declared.length === 0) return Math.min(base, max);
  return Math.min(Math.max(Math.max(...declared), min), max);
}

/**
 * @param {number|string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Whether a health entry is holding the relay out of rotation for quota.
 *
 * @param {{ cooldownUntil?: number|string, errorClass?: string }|null|undefined} healthEntry
 * @param {number} now - Current epoch milliseconds.
 * @returns {boolean}
 */
export function isQuotaBlocked(healthEntry, now) {
  return healthEntry?.errorClass === "quota" && Number(healthEntry?.cooldownUntil) > now;
}

/**
 * @param {number} baseMs
 * @param {number} maxMs
 * @param {number} failStreak
 * @returns {number}
 */
function scaledCooldown(baseMs, maxMs, failStreak) {
  const streak = Number(failStreak);
  const safeStreak = Number.isNaN(streak) ? 1 : streak;
  const exponent = Math.min(Math.max(safeStreak - 1, 0), 10);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * Apply symmetric random jitter, returning an integer within the bounds.
 *
 * @param {number} ms - Base duration in milliseconds.
 * @param {number} [ratio=0.2] - Fractional jitter (0.2 = +/-20%).
 * @param {() => number} [rand=Math.random] - Random source in [0, 1).
 * @returns {number} Jittered duration, or 0 when `ms` is not positive.
 */
export function applyJitter(ms, ratio = 0.2, rand = Math.random) {
  const base = Number(ms);
  if (!Number.isFinite(base) || base <= 0) return 0;

  const r = Number(rand());
  const clampedRand = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  const min = base * (1 - ratio);
  const max = base * (1 + ratio);
  const value = Math.round(min + (max - min) * clampedRand);

  // Rounding could step outside a fractional bound; clamp back into it.
  return Math.min(Math.max(value, Math.ceil(min)), Math.floor(max));
}

/**
 * Whether a health entry's cooldown is still active.
 *
 * @param {{ cooldownUntil?: number|string }|null|undefined} healthEntry
 * @param {number} now - Current epoch milliseconds.
 * @returns {boolean}
 */
export function isRelayCooling(healthEntry, now) {
  return Number(healthEntry?.cooldownUntil) > now;
}

/**
 * Split candidates into healthy and cooling buckets, preserving input order.
 *
 * @param {Array<{ id: string }>} candidates
 * @param {Record<string, { cooldownUntil?: number|string }>} health
 * @param {number} now - Current epoch milliseconds.
 * @returns {{ healthy: Array<{ id: string }>, cooling: Array<{ id: string }> }}
 */
export function partitionRelayCandidates(candidates, health, now) {
  const healthy = [];
  const cooling = [];
  const list = Array.isArray(candidates) ? candidates : [];
  const healthMap = health || {};

  for (const candidate of list) {
    if (isRelayCooling(healthMap[candidate?.id], now)) {
      cooling.push(candidate);
    } else {
      healthy.push(candidate);
    }
  }

  return { healthy, cooling };
}

/**
 * Put the last-known-good provider first without disturbing the rest.
 *
 * @param {Array<{ id: string }>} healthy
 * @param {string|null|undefined} lkgpId
 * @returns {Array<{ id: string }>} A new array.
 */
export function orderRelayCandidates(healthy, lkgpId) {
  const list = Array.isArray(healthy) ? healthy.slice() : [];
  const index = list.findIndex((candidate) => candidate?.id === lkgpId);
  if (index <= 0) return list;
  return [list[index], ...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * Decay a failure streak for elapsed quiet time, then count the new failure.
 *
 * @param {number} prevStreak - Streak before this failure.
 * @param {number} now - Current epoch milliseconds.
 * @param {number} lastFailureAt - Epoch milliseconds of the previous failure.
 * @param {number} [decayMs=1_800_000] - Quiet time that removes one failure.
 * @returns {number}
 */
export function nextFailStreak(prevStreak, now, lastFailureAt, decayMs = 1_800_000) {
  const prev = Number(prevStreak);
  const streak = Number.isFinite(prev) ? Math.max(0, prev) : 0;
  const last = Number(lastFailureAt);
  const decay = Number(decayMs);

  if (!Number.isFinite(last) || !Number.isFinite(decay) || decay <= 0) {
    return streak + 1;
  }

  const elapsed = Number(now) - last;
  const decayed = elapsed > 0 ? Math.floor(elapsed / decay) : 0;
  return Math.max(0, streak - decayed) + 1;
}
