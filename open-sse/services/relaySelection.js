/**
 * Pure relay selection helpers.
 *
 * Combines relay-health partitioning with last-known-good-provider preference.
 * No app imports, no I/O, and no implicit clock reads: callers pass `now`
 * explicitly so selection stays deterministic.
 */

import { partitionRelayCandidates, orderRelayCandidates, isQuotaBlocked } from "./relayHealth.js";

/**
 * Choose a relay candidate by pin, LKGP, health, then earliest cooldown probe.
 *
 * @param {object} options
 * @param {Array<{ id: string }>} options.candidates
 * @param {Record<string, { cooldownUntil?: number|string }>} [options.health]
 * @param {string|null} [options.lkgpId]
 * @param {string|null} [options.pinId]
 * @param {number} [options.now]
 * @param {boolean} [options.allowProbe]
 * @param {number} [options.probeIntervalMs] - Minimum spacing between probes of an
 *   all-quota-blocked pool, measured from its most recent failure.
 * @returns {{ mode: "none"|"pinned"|"lkgp"|"healthy"|"probe"|"exhausted", chosen: { id: string }|null, ordered: Array<{ id: string }>, cooling: Array<{ id: string }>, retryAt?: number|null }}
 */
export function chooseRelay({
  candidates,
  health = {},
  lkgpId = null,
  pinId = null,
  now = 0,
  allowProbe = true,
  probeIntervalMs = 300_000,
}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) {
    return { mode: "none", chosen: null, ordered: [], cooling: [] };
  }

  if (pinId != null) {
    const pinned = list.find((candidate) => candidate?.id === pinId);
    if (pinned) {
      return { mode: "pinned", chosen: pinned, ordered: list, cooling: [] };
    }
  }

  const { healthy, cooling } = partitionRelayCandidates(list, health, now);

  if (healthy.length > 0) {
    const ordered = orderRelayCandidates(healthy, lkgpId);
    const lkgpHealthy = lkgpId != null && healthy.some((candidate) => candidate?.id === lkgpId);
    if (lkgpHealthy) {
      return { mode: "lkgp", chosen: ordered[0], ordered, cooling };
    }
    return { mode: "healthy", chosen: ordered[0], ordered, cooling };
  }

  if (cooling.length > 0 && allowProbe) {
    const ordered = cooling
      .map((candidate, index) => ({
        candidate,
        index,
        until: Number(health?.[candidate?.id]?.cooldownUntil),
      }))
      .sort((a, b) => a.until - b.until || a.index - b.index)
      .map(({ candidate }) => candidate);

    // A quota-blocked relay carries an upstream deadline, not a backoff guess.
    // Probing it on every request is what turns one exhausted pool into a storm
    // of 429s, so an all-quota pool is probed at most once per interval.
    if (ordered.every((candidate) => isQuotaBlocked(health?.[candidate?.id], now))) {
      const lastFailureAt = ordered.reduce(
        (latest, candidate) => Math.max(latest, Number(health?.[candidate?.id]?.lastFailureAt) || 0),
        0
      );
      if (now - lastFailureAt < probeIntervalMs) {
        return { mode: "exhausted", chosen: null, ordered, cooling, retryAt: earliestCooldown(ordered, health) };
      }
    }

    return { mode: "probe", chosen: ordered[0], ordered, cooling };
  }

  return { mode: "none", chosen: null, ordered: [], cooling };
}

/**
 * Earliest cooldown expiry among the given candidates.
 *
 * @param {Array<{ id: string }>} candidates
 * @param {Record<string, { cooldownUntil?: number|string }>} health
 * @returns {number|null}
 */
function earliestCooldown(candidates, health) {
  let earliest = null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const until = Number(health?.[candidate?.id]?.cooldownUntil);
    if (!Number.isFinite(until)) continue;
    if (earliest == null || until < earliest) earliest = until;
  }
  return earliest;
}
