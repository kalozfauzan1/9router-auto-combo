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
 * @returns {"transient"|"ip-quarantine"|"credential"|"identity"|"model-lane"|"request"}
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
    case "ip-quarantine":
      return scaledCooldown(cfg.ipQuarantineMs ?? 1_800_000, cfg.ipQuarantineMaxMs ?? 3_600_000, failStreak);
    case "transient":
      return scaledCooldown(cfg.transientMs ?? 30_000, cfg.transientMaxMs ?? 300_000, failStreak);
    default:
      return 0;
  }
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
