import { describe, it, expect } from "vitest";

import {
  classifyRelayError,
  relayCooldownMs,
  applyJitter,
  isRelayCooling,
  partitionRelayCandidates,
  orderRelayCandidates,
  nextFailStreak,
} from "open-sse/services/relayHealth.js";

describe("classifyRelayError", () => {
  it("classifies abusive-traffic text as ip-quarantine before checking status", () => {
    expect(classifyRelayError(403, "OpenCode detected abusive traffic from this IP")).toBe("ip-quarantine");
    expect(classifyRelayError(500, "ABUSIVE TRAFFIC detected (request 123)")).toBe("ip-quarantine");
    expect(classifyRelayError(400, "abusive traffic")).toBe("ip-quarantine");
  });

  it("classifies both 403 OpenCode identity variants", () => {
    expect(classifyRelayError(403, "This key can only be used from within OpenCode")).toBe("identity");
    expect(
      classifyRelayError(403, "free tier can only be used from within OpenCode")
    ).toBe("identity");
  });

  it("classifies free-tier OpenCode wording as identity even without the full phrase", () => {
    expect(classifyRelayError(403, "Free tier is restricted to OpenCode clients")).toBe("identity");
  });

  it("lets identity text win over a model-lane status", () => {
    expect(classifyRelayError(404, "This token can only be used from within OpenCode")).toBe("identity");
  });

  it("classifies 404 and 410 as model-lane", () => {
    expect(classifyRelayError(404, "model not found")).toBe("model-lane");
    expect(classifyRelayError(410, "model retired")).toBe("model-lane");
  });

  it("classifies 400 and 422 as request", () => {
    expect(classifyRelayError(400, "invalid parameter")).toBe("request");
    expect(classifyRelayError(422, "unprocessable entity")).toBe("request");
  });

  it("classifies 401 and 402 as credential", () => {
    expect(classifyRelayError(401, "unauthorized")).toBe("credential");
    expect(classifyRelayError(402, "payment required")).toBe("credential");
  });

  it("classifies 429 as transient", () => {
    expect(classifyRelayError(429, "rate limited")).toBe("transient");
  });

  it("classifies 5xx as transient", () => {
    expect(classifyRelayError(500, "internal error")).toBe("transient");
    expect(classifyRelayError(502, "bad gateway")).toBe("transient");
    expect(classifyRelayError(503, "unavailable")).toBe("transient");
    expect(classifyRelayError(599, "unknown server error")).toBe("transient");
  });

  it("falls back to transient for everything else", () => {
    expect(classifyRelayError(403, "forbidden")).toBe("transient");
    expect(classifyRelayError(418, "teapot")).toBe("transient");
    expect(classifyRelayError(undefined, undefined)).toBe("transient");
    expect(classifyRelayError(302, "redirect")).toBe("transient");
  });
});

describe("relayCooldownMs", () => {
  it("never cools request, identity, or model-lane failures", () => {
    for (const errorClass of ["request", "identity", "model-lane"]) {
      expect(relayCooldownMs(errorClass, 1)).toBe(0);
      expect(relayCooldownMs(errorClass, 9)).toBe(0);
      expect(
        relayCooldownMs(errorClass, 9, {
          credentialMs: 1,
          transientMs: 1,
          ipQuarantineMs: 1,
        })
      ).toBe(0);
    }
  });

  it("uses a flat credential cooldown of 30 minutes by default", () => {
    expect(relayCooldownMs("credential", 1)).toBe(1_800_000);
    expect(relayCooldownMs("credential", 5)).toBe(1_800_000);
  });

  it("honors a credential cooldown override", () => {
    expect(relayCooldownMs("credential", 3, { credentialMs: 42 })).toBe(42);
    expect(relayCooldownMs("credential", 3, { credentialMs: 0 })).toBe(0);
  });

  it("doubles transient cooldowns from 30s and caps at 300s", () => {
    expect(relayCooldownMs("transient", 1)).toBe(30_000);
    expect(relayCooldownMs("transient", 2)).toBe(60_000);
    expect(relayCooldownMs("transient", 3)).toBe(120_000);
    expect(relayCooldownMs("transient", 4)).toBe(240_000);
    expect(relayCooldownMs("transient", 5)).toBe(300_000);
    expect(relayCooldownMs("transient", 100)).toBe(300_000);
  });

  it("treats failStreak <= 1 as the transient base value", () => {
    expect(relayCooldownMs("transient", 0)).toBe(30_000);
    expect(relayCooldownMs("transient", -4)).toBe(30_000);
    expect(relayCooldownMs("transient", undefined)).toBe(30_000);
  });

  it("honors transient overrides", () => {
    expect(relayCooldownMs("transient", 1, { transientMs: 100, transientMaxMs: 250 })).toBe(100);
    expect(relayCooldownMs("transient", 2, { transientMs: 100, transientMaxMs: 250 })).toBe(200);
    expect(relayCooldownMs("transient", 3, { transientMs: 100, transientMaxMs: 250 })).toBe(250);
  });

  it("doubles ip-quarantine cooldowns from 30m and caps at 60m", () => {
    expect(relayCooldownMs("ip-quarantine", 1)).toBe(1_800_000);
    expect(relayCooldownMs("ip-quarantine", 2)).toBe(3_600_000);
    expect(relayCooldownMs("ip-quarantine", 3)).toBe(3_600_000);
    expect(relayCooldownMs("ip-quarantine", 1_000)).toBe(3_600_000);

    for (let streak = 1; streak <= 25; streak += 1) {
      expect(relayCooldownMs("ip-quarantine", streak)).toBeLessThanOrEqual(3_600_000);
    }
  });

  it("honors ip-quarantine overrides", () => {
    expect(
      relayCooldownMs("ip-quarantine", 1, { ipQuarantineMs: 10_000, ipQuarantineMaxMs: 50_000 })
    ).toBe(10_000);
    expect(
      relayCooldownMs("ip-quarantine", 2, { ipQuarantineMs: 10_000, ipQuarantineMaxMs: 50_000 })
    ).toBe(20_000);
    expect(
      relayCooldownMs("ip-quarantine", 3, { ipQuarantineMs: 10_000, ipQuarantineMaxMs: 50_000 })
    ).toBe(40_000);
    expect(
      relayCooldownMs("ip-quarantine", 4, { ipQuarantineMs: 10_000, ipQuarantineMaxMs: 50_000 })
    ).toBe(50_000);
  });

  it("returns no cooldown for an unknown class", () => {
    expect(relayCooldownMs("nope", 5)).toBe(0);
  });
});

describe("applyJitter", () => {
  it("returns 0 for non-positive durations", () => {
    expect(applyJitter(0, 0.2, () => 0.5)).toBe(0);
    expect(applyJitter(-1, 0.2, () => 0.5)).toBe(0);
  });

  it("returns the exact lower bound when rand is 0", () => {
    expect(applyJitter(30_000, 0.2, () => 0)).toBe(24_000);
  });

  it("returns the exact upper bound when rand is 1", () => {
    expect(applyJitter(30_000, 0.2, () => 1)).toBe(36_000);
  });

  it("stays integer and within bounds across the random range", () => {
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const value = applyJitter(30_000, 0.2, () => r);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(24_000);
      expect(value).toBeLessThanOrEqual(36_000);
    }
  });

  it("supports a custom ratio", () => {
    expect(applyJitter(10_000, 0.5, () => 0)).toBe(5_000);
    expect(applyJitter(10_000, 0.5, () => 1)).toBe(15_000);
  });

  it("stays within bounds with the default random source", () => {
    for (let i = 0; i < 25; i += 1) {
      const value = applyJitter(1_800_000);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1_440_000);
      expect(value).toBeLessThanOrEqual(2_160_000);
    }
  });
});

describe("isRelayCooling", () => {
  const now = 1_700_000_000_000;

  it("is true only while cooldownUntil is in the future", () => {
    expect(isRelayCooling({ cooldownUntil: now + 1 }, now)).toBe(true);
    expect(isRelayCooling({ cooldownUntil: now }, now)).toBe(false);
    expect(isRelayCooling({ cooldownUntil: now - 1 }, now)).toBe(false);
  });

  it("treats missing, zero, and non-numeric values as not cooling", () => {
    expect(isRelayCooling(undefined, now)).toBe(false);
    expect(isRelayCooling({}, now)).toBe(false);
    expect(isRelayCooling({ cooldownUntil: 0 }, now)).toBe(false);
    expect(isRelayCooling({ cooldownUntil: "nope" }, now)).toBe(false);
  });

  it("coerces numeric strings", () => {
    expect(isRelayCooling({ cooldownUntil: String(now + 5_000) }, now)).toBe(true);
  });
});

describe("partitionRelayCandidates", () => {
  it("splits by cooldownUntil while preserving input order", () => {
    const now = 1_700_000_000_000;
    const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const health = {
      a: { cooldownUntil: now + 60_000 },
      b: { cooldownUntil: now - 60_000 },
      c: { cooldownUntil: now },
      // d has no entry
    };

    const { healthy, cooling } = partitionRelayCandidates(candidates, health, now);

    expect(healthy).toEqual([{ id: "b" }, { id: "c" }, { id: "d" }]);
    expect(cooling).toEqual([{ id: "a" }]);
  });

  it("returns empty buckets for empty or missing input", () => {
    expect(partitionRelayCandidates([], {}, 1)).toEqual({ healthy: [], cooling: [] });
    expect(partitionRelayCandidates(undefined, undefined, 1)).toEqual({ healthy: [], cooling: [] });
  });
});

describe("orderRelayCandidates", () => {
  it("moves LKGP first and keeps the remaining order stable", () => {
    const healthy = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(orderRelayCandidates(healthy, "c")).toEqual([
      { id: "c" },
      { id: "a" },
      { id: "b" },
      { id: "d" },
    ]);
  });

  it("leaves an already-first LKGP in place", () => {
    const healthy = [{ id: "a" }, { id: "b" }];
    expect(orderRelayCandidates(healthy, "a")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("keeps the original order when LKGP is absent or missing", () => {
    const healthy = [{ id: "a" }, { id: "b" }];
    expect(orderRelayCandidates(healthy, "zzz")).toEqual([{ id: "a" }, { id: "b" }]);
    expect(orderRelayCandidates(healthy, null)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("returns a new array without mutating the input", () => {
    const healthy = [{ id: "a" }, { id: "b" }];
    const ordered = orderRelayCandidates(healthy, "b");
    expect(ordered).not.toBe(healthy);
    expect(healthy).toEqual([{ id: "a" }, { id: "b" }]);
    expect(orderRelayCandidates(healthy, null)).not.toBe(healthy);
  });
});

describe("nextFailStreak", () => {
  const decayMs = 1_800_000;
  const last = 1_700_000_000_000;

  it("does not decay before a full decay window", () => {
    expect(nextFailStreak(2, last + 1_000, last, decayMs)).toBe(3);
    expect(nextFailStreak(2, last + decayMs - 1, last, decayMs)).toBe(3);
  });

  it("decays one step for each full window, then increments", () => {
    expect(nextFailStreak(5, last + decayMs, last, decayMs)).toBe(5);
    expect(nextFailStreak(5, last + 2 * decayMs, last, decayMs)).toBe(4);
    expect(nextFailStreak(5, last + Math.floor(2.9 * decayMs), last, decayMs)).toBe(4);
  });

  it("decays to zero and then increments to one", () => {
    expect(nextFailStreak(2, last + 2 * decayMs, last, decayMs)).toBe(1);
    expect(nextFailStreak(2, last + 50 * decayMs, last, decayMs)).toBe(1);
    expect(nextFailStreak(0, last + 50 * decayMs, last, decayMs)).toBe(1);
  });

  it("does not decay when lastFailureAt or decayMs is unusable", () => {
    expect(nextFailStreak(3, last + 50 * decayMs, undefined, decayMs)).toBe(4);
    expect(nextFailStreak(3, last + 50 * decayMs, last, 0)).toBe(4);
  });

  it("supports a custom decay window", () => {
    expect(nextFailStreak(4, last + 3_000, last, 1_000)).toBe(2);
  });

  it("never returns a negative streak", () => {
    expect(nextFailStreak(-5, last, last, decayMs)).toBe(1);
  });
});
