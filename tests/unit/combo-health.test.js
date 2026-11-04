import { describe, it, expect } from "vitest";

import {
  buildComboAttemptOrder,
  selectComboProbeCandidate,
  nextComboFailure,
  parseComboRetryAfter,
} from "../../open-sse/services/comboHealth.js";

const MS_5M = 5 * 60 * 1000;

describe("combo health — attempt order", () => {
  it("no health → identity order preserved", () => {
    const models = ["a/x", "b/y", "c/z"];
    const now = Date.now();
    expect(buildComboAttemptOrder(models, {}, null, now)).toEqual(models);
  });

  it("pins eligible LKGP to front while preserving remainder order", () => {
    const models = ["a/x", "b/y", "c/z"];
    const now = Date.now();
    const health = {};
    expect(buildComboAttemptOrder(models, health, "b/y", now)).toEqual(["b/y", "a/x", "c/z"]);
  });

  it("skips LKGP when it is in cooldown", () => {
    const models = ["a/x", "b/y", "c/z"];
    const now = Date.now();
    const health = { "b/y": { failures: 1, cooldownUntil: now + MS_5M } };
    expect(buildComboAttemptOrder(models, health, "b/y", now)).toEqual(["a/x", "c/z"]);
  });

  it("skips failed concrete members in cooldown", () => {
    const models = ["a/x", "b/y", "c/z"];
    const now = Date.now();
    const health = { "b/y": { failures: 1, cooldownUntil: now + MS_5M } };
    expect(buildComboAttemptOrder(models, health, null, now)).toEqual(["a/x", "c/z"]);
  });

  it("skips failed concrete members whose cooldown expired (await probe)", () => {
    const models = ["a/x", "b/y", "c/z"];
    const now = Date.now();
    const health = { "b/y": { failures: 1, cooldownUntil: now - 1000 } };
    expect(buildComboAttemptOrder(models, health, null, now)).toEqual(["a/x", "c/z"]);
  });

  it("preserves slashless nested auto/smart members", () => {
    const models = ["auto", "a/x", "smart", "b/y"];
    const now = Date.now();
    const health = { "a/x": { failures: 1, cooldownUntil: now + MS_5M } };
    expect(buildComboAttemptOrder(models, health, null, now)).toEqual(["auto", "smart", "b/y"]);
  });

  it("preserves slashless nested auto/smart members even when LKGP is set", () => {
    const models = ["auto", "a/x", "smart", "b/y"];
    const now = Date.now();
    const health = { "a/x": { failures: 1, cooldownUntil: now + MS_5M } };
    expect(buildComboAttemptOrder(models, health, "b/y", now)).toEqual(["b/y", "auto", "smart"]);
  });

  it("does not mutate input models array", () => {
    const models = ["a/x", "b/y"];
    const now = Date.now();
    buildComboAttemptOrder(models, {}, null, now);
    expect(models).toEqual(["a/x", "b/y"]);
  });

  it("does not mutate input health object", () => {
    const models = ["a/x", "b/y"];
    const health = { "a/x": { failures: 1, cooldownUntil: Date.now() + MS_5M } };
    const healthCopy = JSON.parse(JSON.stringify(health));
    buildComboAttemptOrder(models, health, null, Date.now());
    expect(health).toEqual(healthCopy);
  });
});

describe("combo health — probe candidate selection", () => {
  it("returns first failed concrete member whose cooldown expired", () => {
    const models = ["a/x", "b/y", "c/z"];
    const now = Date.now();
    const health = {
      "a/x": { failures: 1, cooldownUntil: now + MS_5M },
      "b/y": { failures: 1, cooldownUntil: now - 1000 },
      "c/z": { failures: 1, cooldownUntil: now - 2000 },
    };
    expect(selectComboProbeCandidate(models, health, now)).toBe("b/y");
  });

  it("returns null when no failed member has expired cooldown", () => {
    const models = ["a/x", "b/y"];
    const now = Date.now();
    const health = { "a/x": { failures: 1, cooldownUntil: now + MS_5M } };
    expect(selectComboProbeCandidate(models, health, now)).toBeNull();
  });

  it("returns null when no failed members at all", () => {
    const models = ["a/x", "b/y"];
    const now = Date.now();
    const health = {};
    expect(selectComboProbeCandidate(models, health, now)).toBeNull();
  });

  it("skips slashless nested auto/smart members (no probe for virtual)", () => {
    const models = ["auto", "a/x", "smart", "b/y"];
    const now = Date.now();
    const health = {
      "auto": { failures: 1, cooldownUntil: now - 1000 },
      "a/x": { failures: 1, cooldownUntil: now - 1000 },
    };
    expect(selectComboProbeCandidate(models, health, now)).toBe("a/x");
  });

  it("expired probe priority: highest-ranked expired failed member wins", () => {
    const models = ["c/z", "b/y", "a/x"]; // ranked order
    const now = Date.now();
    const health = {
      "c/z": { failures: 1, cooldownUntil: now - 1000 },
      "b/y": { failures: 1, cooldownUntil: now - 2000 },
      "a/x": { failures: 1, cooldownUntil: now - 3000 },
    };
    expect(selectComboProbeCandidate(models, health, now)).toBe("c/z");
  });

  it("does not mutate input models array", () => {
    const models = ["a/x", "b/y"];
    const now = Date.now();
    selectComboProbeCandidate(models, {}, now);
    expect(models).toEqual(["a/x", "b/y"]);
  });

  it("does not mutate input health object", () => {
    const models = ["a/x"];
    const health = { "a/x": { failures: 1, cooldownUntil: Date.now() - 1000 } };
    const healthCopy = JSON.parse(JSON.stringify(health));
    selectComboProbeCandidate(models, health, Date.now());
    expect(health).toEqual(healthCopy);
  });
});

describe("combo health — next failure backoff", () => {
  it("default floor 300000ms when no previous failure and no retryAfter", () => {
    const now = Date.now();
    const next = nextComboFailure({}, { now, retryAfterMs: null });
    expect(next.cooldownUntil).toBe(now + 300000);
    expect(next.failures).toBe(1);
  });

  it("honors longer retryAfterMs over default floor", () => {
    const now = Date.now();
    const next = nextComboFailure({}, { now, retryAfterMs: 600000 });
    expect(next.cooldownUntil).toBe(now + 600000);
    expect(next.failures).toBe(1);
  });

  it("increments failures from previous state", () => {
    const now = Date.now();
    const previous = { failures: 2, cooldownUntil: now - 1000 };
    const next = nextComboFailure(previous, { now, retryAfterMs: null });
    expect(next.failures).toBe(3);
    expect(next.cooldownUntil).toBe(now + 300000);
  });

  it("uses max of default floor and previous cooldownUntil when no retryAfter", () => {
    const now = Date.now();
    const previous = { failures: 1, cooldownUntil: now + 100000 }; // 100s in future
    const next = nextComboFailure(previous, { now, retryAfterMs: null });
    expect(next.cooldownUntil).toBe(now + 300000); // default 5m floor wins
  });

  it("uses max of retryAfterMs and previous cooldownUntil when both present", () => {
    const now = Date.now();
    const previous = { failures: 1, cooldownUntil: now + 400000 };
    const next = nextComboFailure(previous, { now, retryAfterMs: 600000 });
    expect(next.cooldownUntil).toBe(now + 600000);
  });

  it("does not mutate previous object", () => {
    const now = Date.now();
    const previous = { failures: 1, cooldownUntil: now + 1000 };
    const prevCopy = JSON.parse(JSON.stringify(previous));
    nextComboFailure(previous, { now, retryAfterMs: null });
    expect(previous).toEqual(prevCopy);
  });
});

describe("combo health — parse Retry-After", () => {
  const now = Date.UTC(2026, 0, 1);

  it("parses delta seconds (numeric string)", () => {
    expect(parseComboRetryAfter("60", now)).toBe(60000);
    expect(parseComboRetryAfter("0", now)).toBe(0);
  });

  it("parses HTTP date (RFC 7231)", () => {
    const future = new Date(now + 120000).toUTCString(); // 2 min in future
    expect(parseComboRetryAfter(future, now)).toBeCloseTo(120000, -2); // ~120000ms
  });

  it("returns 0 for invalid value", () => {
    expect(parseComboRetryAfter("not-a-number", now)).toBe(0);
    expect(parseComboRetryAfter("", now)).toBe(0);
    expect(parseComboRetryAfter(null, now)).toBe(0);
    expect(parseComboRetryAfter(undefined, now)).toBe(0);
    expect(parseComboRetryAfter("invalid-date", now)).toBe(0);
  });

  it("returns 0 for past HTTP date", () => {
    const past = new Date(now - 1000).toUTCString();
    expect(parseComboRetryAfter(past, now)).toBe(0);
  });

  it("returns 0 for negative delta seconds", () => {
    expect(parseComboRetryAfter("-10", now)).toBe(0);
  });

  it("floor at 0 for edge cases", () => {
    expect(parseComboRetryAfter("-1", now)).toBe(0);
  });
});