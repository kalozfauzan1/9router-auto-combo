/**
 * Pure relay selection helpers.
 *
 * Combines relay-health partitioning with last-known-good-provider preference.
 * No app imports, no I/O, and no implicit clock reads: callers pass `now`
 * explicitly so selection stays deterministic.
 */

import { partitionRelayCandidates, orderRelayCandidates } from "./relayHealth.js";

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
 * @returns {{ mode: "none"|"pinned"|"lkgp"|"healthy"|"probe", chosen: { id: string }|null, ordered: Array<{ id: string }>, cooling: Array<{ id: string }> }}
 */
export function chooseRelay({
  candidates,
  health = {},
  lkgpId = null,
  pinId = null,
  now = 0,
  allowProbe = true,
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

    return { mode: "probe", chosen: ordered[0], ordered, cooling };
  }

  return { mode: "none", chosen: null, ordered: [], cooling };
}
