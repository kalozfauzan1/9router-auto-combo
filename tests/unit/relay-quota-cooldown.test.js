// Per-pool quota cooldown for the OpenCode free lane.
//
// The free lane answers 429 with a Retry-After measured in hours and applies
// the limit per account and per network/IP. These tests pin the pieces that
// keep an exhausted relay out of rotation until that deadline instead of
// re-probing it every backoff tick.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep both KV scopes in RAM only; the SQLite kv layer is not under test here.
const { kvStores } = vi.hoisted(() => ({ kvStores: new Map() }));

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: (scope) => {
    if (!kvStores.has(scope)) kvStores.set(scope, new Map());
    const map = kvStores.get(scope);
    const clone = (value) => (value === undefined ? value : structuredClone(value));

    return {
      get: async (key, fallback = null) => (map.has(key) ? clone(map.get(key)) : fallback),
      set: async (key, value) => { map.set(key, clone(value)); },
      remove: async (key) => { map.delete(key); },
      getAll: async () => {
        const out = {};
        for (const [key, value] of map) out[key] = clone(value);
        return out;
      },
      clear: async () => { map.clear(); },
    };
  },
}));

const {
  classifyRelayError,
  isQuotaErrorText,
  parseRetryAfterMs,
  quotaCooldownMs,
  isQuotaBlocked,
} = await import("open-sse/services/relayHealth.js");
const { chooseRelay } = await import("open-sse/services/relaySelection.js");
const { parseUpstreamError } = await import("open-sse/utils/error.js");
const {
  bumpRelayFailure,
  getRelayHealthForModel,
  resetRelayHealth,
  clearAllRelayHealth,
} = await import("@/lib/db/repos/relayLkgpRepo.js");

const FREE_QUOTA_429 =
  "Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go";

beforeEach(async () => {
  await clearAllRelayHealth();
});

describe("quota error classification", () => {
  it("treats the free-lane rejection as a hard quota, not a transient 429", () => {
    expect(classifyRelayError(429, FREE_QUOTA_429)).toBe("quota");
    expect(classifyRelayError(429, "FreeUsageLimitError")).toBe("quota");
    expect(isQuotaErrorText(FREE_QUOTA_429)).toBe(true);
  });

  it("leaves ordinary rate limits in the transient lane", () => {
    expect(classifyRelayError(429, "rate limit exceeded")).toBe("transient");
    expect(classifyRelayError(500, "boom")).toBe("transient");
    expect(isQuotaErrorText("rate limit exceeded")).toBe(false);
  });

  it("still gives identity rejects and ip quarantines their own classes", () => {
    expect(classifyRelayError(403, "free tier can only be used from within OpenCode")).toBe("identity");
    expect(classifyRelayError(403, "OpenCode detected abusive traffic from this IP address")).toBe("ip-quarantine");
  });
});

describe("parseRetryAfterMs", () => {
  const now = 1_700_000_000_000;

  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs("56140", now)).toBe(56_140_000);
    expect(parseRetryAfterMs(120, now)).toBe(120_000);
  });

  it("reads an HTTP-date", () => {
    const at = new Date(now + 90_000).toUTCString();
    expect(parseRetryAfterMs(at, now)).toBe(90_000);
  });

  it("clamps a past date to zero and rejects unusable values", () => {
    expect(parseRetryAfterMs(new Date(now - 5_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfterMs("not-a-date", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
  });
});

describe("quotaCooldownMs", () => {
  const now = 1_700_000_000_000;

  it("honours the upstream deadline", () => {
    expect(quotaCooldownMs({ retryAfterMs: 120_000, now })).toBe(120_000);
  });

  it("caps a very long deadline at the 6 hour ceiling", () => {
    expect(quotaCooldownMs({ retryAfterMs: 56_140_000, now })).toBe(6 * 60 * 60 * 1000);
  });

  it("keeps a tiny deadline from turning into a probe storm", () => {
    expect(quotaCooldownMs({ retryAfterMs: 5_000, now })).toBe(60_000);
  });

  it("falls back to a 15 minute floor without any deadline", () => {
    expect(quotaCooldownMs({ now })).toBe(900_000);
  });

  it("accepts a resets-at timestamp as the deadline", () => {
    expect(quotaCooldownMs({ resetsAtMs: now + 300_000, now })).toBe(300_000);
  });

  it("honours caller overrides", () => {
    expect(quotaCooldownMs({ retryAfterMs: 120_000, now, config: { quotaMaxMs: 60_000 } })).toBe(60_000);
    expect(quotaCooldownMs({ now, config: { quotaMs: 60_000 } })).toBe(60_000);
  });
});

describe("chooseRelay with quota-blocked relays", () => {
  const candidate = (id) => ({ id });
  const now = 1_700_000_000_000;

  it("prefers a healthy relay over a quota-blocked one", () => {
    const result = chooseRelay({
      candidates: [candidate("pool-a"), candidate("pool-b")],
      health: {
        "pool-a": { errorClass: "quota", cooldownUntil: now + 3_600_000, lastFailureAt: now },
        "pool-b": { errorClass: null, cooldownUntil: 0 },
      },
      lkgpId: "pool-a",
      now,
    });

    expect(result.mode).toBe("healthy");
    expect(result.chosen.id).toBe("pool-b");
  });

  it("reports exhausted instead of probing an all-quota pool on every request", () => {
    const result = chooseRelay({
      candidates: [candidate("pool-a"), candidate("pool-b")],
      health: {
        "pool-a": { errorClass: "quota", cooldownUntil: now + 3_600_000, lastFailureAt: now },
        "pool-b": { errorClass: "quota", cooldownUntil: now + 7_200_000, lastFailureAt: now },
      },
      now,
      probeIntervalMs: 300_000,
    });

    expect(result.mode).toBe("exhausted");
    expect(result.chosen).toBeNull();
    expect(result.retryAt).toBe(now + 3_600_000);
  });

  it("allows one probe once the interval has passed", () => {
    const result = chooseRelay({
      candidates: [candidate("pool-a")],
      health: {
        "pool-a": { errorClass: "quota", cooldownUntil: now + 3_600_000, lastFailureAt: now - 600_000 },
      },
      now,
      probeIntervalMs: 300_000,
    });

    expect(result.mode).toBe("probe");
    expect(result.chosen.id).toBe("pool-a");
  });

  it("still probes a transient cooldown ahead of a quota cooldown", () => {
    const result = chooseRelay({
      candidates: [candidate("pool-a"), candidate("pool-b")],
      health: {
        "pool-a": { errorClass: "quota", cooldownUntil: now + 3_600_000, lastFailureAt: now },
        "pool-b": { errorClass: "transient", cooldownUntil: now + 30_000, lastFailureAt: now },
      },
      now,
    });

    expect(result.mode).toBe("probe");
    expect(result.chosen.id).toBe("pool-b");
  });
});

describe("relay health scope", () => {
  it("applies a pool-scoped quota block to every model lane of that relay", async () => {
    await bumpRelayFailure("proxy:pool-a", "deepseek-v4.1-flash-free", {
      errorClass: "quota",
      cooldownMs: 3_600_000,
      scope: "pool",
    });

    const health = await getRelayHealthForModel("some-other-model", ["proxy:pool-a"]);
    expect(health["proxy:pool-a"]).toBeTruthy();
    expect(health["proxy:pool-a"].errorClass).toBe("quota");
    expect(isQuotaBlocked(health["proxy:pool-a"], Date.now())).toBe(true);
  });

  it("keeps a model-scoped failure out of other lanes", async () => {
    await bumpRelayFailure("proxy:pool-b", "model-x", {
      errorClass: "transient",
      cooldownMs: 30_000,
    });

    const health = await getRelayHealthForModel("model-y", ["proxy:pool-b"]);
    expect(health["proxy:pool-b"]).toBeUndefined();
  });

  it("clears the pool-wide block once the relay succeeds again", async () => {
    await bumpRelayFailure("proxy:pool-c", "model-x", {
      errorClass: "quota",
      cooldownMs: 3_600_000,
      scope: "pool",
    });
    await resetRelayHealth("proxy:pool-c", "model-x");

    const health = await getRelayHealthForModel("model-y", ["proxy:pool-c"]);
    expect(isQuotaBlocked(health["proxy:pool-c"], Date.now())).toBe(false);
  });
});

describe("parseUpstreamError", () => {
  it("surfaces the upstream Retry-After as a duration", async () => {
    const response = new Response(JSON.stringify({ error: { message: FREE_QUOTA_429 } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "56140" },
    });

    const parsed = await parseUpstreamError(response);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.retryAfterMs).toBe(56_140_000);
  });

  it("reports no deadline when the upstream sends none", async () => {
    const response = new Response(JSON.stringify({ error: { message: "boom" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

    const parsed = await parseUpstreamError(response);
    expect(parsed.retryAfterMs).toBeNull();
  });
});
