import { describe, it, expect } from "vitest";

import { chooseRelay } from "open-sse/services/relaySelection.js";

const candidate = (id) => ({ id });

describe("chooseRelay", () => {
  it("returns none for an empty candidate list", () => {
    expect(chooseRelay({ candidates: [], health: {}, now: 100 })).toEqual({
      mode: "none",
      chosen: null,
      ordered: [],
      cooling: [],
    });
    expect(chooseRelay({ candidates: undefined })).toEqual({
      mode: "none",
      chosen: null,
      ordered: [],
      cooling: [],
    });
  });

  it("pins a candidate even when another candidate is the LKGP", () => {
    const candidates = [candidate("a"), candidate("b")];

    const result = chooseRelay({
      candidates,
      health: {},
      lkgpId: "b",
      pinId: "a",
      now: 100,
    });

    expect(result.mode).toBe("pinned");
    expect(result.chosen).toEqual({ id: "a" });
    expect(result.ordered).toEqual(candidates);
    expect(result.cooling).toEqual([]);
  });

  it("prefers the LKGP over a candidate with healthier-looking metrics", () => {
    const now = 1_000;
    const candidates = [candidate("fresh"), candidate("lkgp")];
    const health = {
      fresh: { failStreak: 0, lastSuccessAt: now, cooldownUntil: 0 },
      lkgp: { failStreak: 9, lastFailureAt: now, cooldownUntil: 0 },
    };

    const result = chooseRelay({ candidates, health, lkgpId: "lkgp", now });

    expect(result.mode).toBe("lkgp");
    expect(result.chosen.id).toBe("lkgp");
    expect(result.ordered.map((c) => c.id)).toEqual(["lkgp", "fresh"]);
    expect(result.cooling).toEqual([]);
  });

  it("falls back to healthy candidates in input order when the LKGP is cooling", () => {
    const now = 1_000;
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const health = { b: { cooldownUntil: now + 5_000 } };

    const result = chooseRelay({ candidates, health, lkgpId: "b", now });

    expect(result.mode).toBe("healthy");
    expect(result.chosen.id).toBe("a");
    expect(result.ordered.map((c) => c.id)).toEqual(["a", "c"]);
    expect(result.cooling.map((c) => c.id)).toEqual(["b"]);
  });

  it("probes the cooling candidate with the earliest expiry", () => {
    const now = 1_000;
    const candidates = [candidate("late"), candidate("early"), candidate("middle")];
    const health = {
      late: { cooldownUntil: now + 30_000 },
      early: { cooldownUntil: now + 5_000 },
      middle: { cooldownUntil: now + 10_000 },
    };

    const result = chooseRelay({ candidates, health, lkgpId: "late", now });

    expect(result.mode).toBe("probe");
    expect(result.chosen.id).toBe("early");
    expect(result.ordered.map((c) => c.id)).toEqual(["early", "middle", "late"]);
    expect(result.cooling.map((c) => c.id)).toEqual(["late", "early", "middle"]);
  });

  it("keeps probe order stable when cooldowns expire at the same time", () => {
    const now = 1_000;
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const health = {
      a: { cooldownUntil: now + 3_000 },
      b: { cooldownUntil: now + 2_000 },
      c: { cooldownUntil: now + 2_000 },
    };

    const result = chooseRelay({ candidates, health, now });

    expect(result.mode).toBe("probe");
    expect(result.chosen.id).toBe("b");
    expect(result.ordered.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("returns none when every candidate is cooling and probing is disabled", () => {
    const now = 1_000;
    const candidates = [candidate("a"), candidate("b")];
    const health = {
      a: { cooldownUntil: now + 5_000 },
      b: { cooldownUntil: now + 10_000 },
    };

    const result = chooseRelay({ candidates, health, now, allowProbe: false });

    expect(result.mode).toBe("none");
    expect(result.chosen).toBeNull();
    expect(result.ordered).toEqual([]);
    expect(result.cooling.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("treats an empty health map as all healthy", () => {
    const candidates = [candidate("a"), candidate("b")];

    const result = chooseRelay({ candidates, health: {}, now: 100 });

    expect(result.mode).toBe("healthy");
    expect(result.chosen.id).toBe("a");
    expect(result.ordered.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.cooling).toEqual([]);
  });

  it("keeps non-LKGP candidates in input order when the LKGP is healthy", () => {
    const candidates = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];

    const result = chooseRelay({ candidates, health: {}, lkgpId: "c", now: 100 });

    expect(result.mode).toBe("lkgp");
    expect(result.chosen.id).toBe("c");
    expect(result.ordered.map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
    expect(result.cooling).toEqual([]);
  });
});
