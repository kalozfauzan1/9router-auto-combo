import { createComboHealthRepo } from "../../lib/db/repos/comboLkgpRepo.js";
import { buildComboAttemptOrder, parseComboRetryAfter, selectComboProbeCandidate, usableComboPayload } from "../../../open-sse/services/comboHealth.js";
import { buildAutoProbeBody } from "../../../open-sse/services/autoCombo.js";

const concrete = (member) => typeof member === "string" && member.includes("/");

// Cancellation is best-effort and never extends the bounded probe race.
function cancelBody(body) { try { void body?.cancel().catch(() => {}); } catch {} }

/** Standalone building block; caller owns fallback opt-in and capability gating.
 * executeProbe receives { combo, model, body, signal } and returns a Fetch
 * Response (non-streaming JSON). No user history/tools are passed through. */
export function createComboHealthService({ store, executeProbe, now = Date.now, timeoutMs = 10000, log = console } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive and finite");
  const repo = createComboHealthRepo({ store });
  const flights = new Map();
  const service = {
    getHealth: repo.getHealth,
    beginAttempt: repo.beginAttempt,
    async recordFailure(combo, member, { retryAfter, requestScoped = false } = {}) {
      if (!concrete(member) || requestScoped) return null;
      const timestamp = now();
      return repo.recordFailure(combo, member, { now: timestamp, retryAfterMs: parseComboRetryAfter(retryAfter, timestamp) });
    },
    async recordSuccess(combo, member, attempt) {
      if (!concrete(member)) return false;
      const accepted = await repo.recordSuccess(combo, member, attempt);
      if (accepted) await repo.setPin(combo, member, attempt);
      return accepted;
    },
    async getAttemptOrder(combo, members) {
      return buildComboAttemptOrder(members, await repo.getHealth(combo, members), await repo.getPin(combo), now());
    },
    async recover(combo, members, sourceBody = {}, probeExecutor = executeProbe) {
      if (flights.has(combo)) return { status: "busy" };
      // Identity is the generation guard: timed-out work cannot affect a later
      // flight even if its executor ignores AbortSignal and eventually resolves.
      const flight = { active: true };
      flights.set(combo, flight);
      let timer;
      let reader;
      const controller = new AbortController();
      const current = () => flight.active && flights.get(combo) === flight;
      try {
        const health = await repo.getHealth(combo, members);
        const model = selectComboProbeCandidate(members, health, now());
        if (!model || typeof probeExecutor !== "function") return { status: "idle" };
        const attempt = await repo.beginAttempt(combo, model);
        const work = Promise.resolve().then(async () => {
          const response = await probeExecutor({ combo, model, body: buildAutoProbeBody(sourceBody), signal: controller.signal });
          if (!current()) {
            cancelBody(response?.body);
            return { status: "stale" };
          }
          const status = response?.status;
          if (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)) {
            cancelBody(response.body);
            return { status: "request-scoped" };
          }
          if (!response?.ok) {
            cancelBody(response?.body);
            return { status: "failed", retryAfter: response?.headers?.get("retry-after") };
          }
          if (!response.body) return { status: "failed" };
          // Own the reader so a stalled body can be cancelled on timeout, even
          // while read() is pending (Response.json() would lock it internally).
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let body = "";
          try {
            while (current()) {
              const chunk = await reader.read();
              if (!current()) return { status: "stale" };
              if (chunk.done) break;
              body += decoder.decode(chunk.value, { stream: true });
            }
            if (!current()) return { status: "stale" };
            body += decoder.decode();
            return { status: usableComboPayload(JSON.parse(body)) ? "usable" : "failed" };
          } finally {
            reader.releaseLock();
            reader = null;
          }
        }).catch(() => ({ status: "failed" }));
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => {
            flight.active = false;
            controller.abort();
            cancelBody(reader);
            resolve({ status: "timeout" });
          }, timeoutMs);
        });
        const result = await Promise.race([work, timeout]);
        clearTimeout(timer);
        // No persistence happens inside work: its late completion is inert.
        flight.active = false;
        if (result.status === "usable") {
          if (!await repo.recordSuccess(combo, model, attempt)) return { status: "stale", model };
          const updated = await repo.getHealth(combo, members);
          const pin = await repo.getPin(combo);
          const earliest = members.find((member) => concrete(member) && !(updated[member]?.failures > 0));
          if (earliest && (!members.includes(pin) || members.indexOf(earliest) < members.indexOf(pin))) {
            await repo.setPin(combo, earliest, attempt, { members });
          }
          return { status: "recovered", model };
        }
        if (result.status === "failed" || result.status === "timeout") {
          await service.recordFailure(combo, model, { retryAfter: result.retryAfter });
        }
        return { status: result.status, model };
      } finally {
        clearTimeout(timer);
        flight.active = false;
        if (flights.get(combo) === flight) flights.delete(combo);
      }
    },
  };
  // Health is advisory: neither storage nor diagnostic failures may escape
  // into the provider retry path (including post-response success writes).
  const fallback = {
    getHealth: () => ({}),
    beginAttempt: () => null,
    recordFailure: () => null,
    recordSuccess: () => false,
    getAttemptOrder: (_combo, members) => [...members],
    recover: () => ({ status: "unavailable" }),
  };
  for (const [name, onError] of Object.entries(fallback)) {
    const operation = service[name];
    service[name] = async (...args) => {
      try { return await operation(...args); }
      catch (error) {
        try { void Promise.resolve(log?.warn?.("COMBO_HEALTH", `${name} unavailable`, error)).catch(() => {}); } catch {}
        return onError(...args);
      }
    };
  }
  return service;
}

// One process-wide lock set and the default persistent store for all chat paths.
export const comboHealthService = createComboHealthService();
