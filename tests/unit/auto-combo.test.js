import { describe, it, expect } from "vitest";

import {
  isAutoComboName,
  orderByRank,
  collectRankedAutoModels,
  classifyAutoError,
  getAutoCooldownMs,
  getModelState,
  recordAutoFailure,
  recordAutoSuccess,
  buildAutoAttemptOrder,
  selectProbeCandidate,
  buildAutoProbeBody,
  parseRanksPayload,
  shouldPromoteLkgp,
  buildRankRows,
  parseScoreInput,
  applyModelScore,
  resolveScoreDraft,
  createRequestGate,
  isRankEditorBusy,
} from "../../open-sse/services/autoCombo.js";

describe("auto/smart virtual combo ranking", () => {
  it("recognizes auto and smart as virtual combo names", () => {
    expect(isAutoComboName("auto")).toBe(true);
    expect(isAutoComboName("smart")).toBe(true);
    expect(isAutoComboName("my-combo")).toBe(false);
  });

  it("orders registered models highest rank first (higher number = smarter)", () => {
    const models = ["b/model-2", "a/model-1", "c/model-3"];
    const ranks = { "a/model-1": 1, "b/model-2": 2, "c/model-3": 3 };
    expect(orderByRank(models, ranks)).toEqual(["c/model-3", "b/model-2", "a/model-1"]);
  });

  it("breaks equal-rank ties and orders unscored models deterministically by provider/model", () => {
    const models = ["z/m", "b/m", "a/m", "m/c", "m/a"];
    const ranks = { "z/m": 5, "b/m": 5, "m/c": 5 };
    expect(orderByRank(models, ranks)).toEqual(["b/m", "m/c", "z/m", "a/m", "m/a"]);
  });
});

describe("auto/smart inline score rows", () => {
  it("builds scored-first rows with deterministic ties and unscored eligible rows last", () => {
    const models = ["p/b", "p/a", "p/d", "p/c", "p/a"];
    const ranks = { "p/a": 5, "p/b": 5, "p/c": 10 };
    expect(buildRankRows(models, ranks)).toEqual([
      { model: "p/c", rank: 10 },
      { model: "p/a", rank: 5 },
      { model: "p/b", rank: 5 },
      { model: "p/d", rank: null },
    ]);
  });

  it("treats malformed stored scores as unscored", () => {
    const rows = buildRankRows(["p/a", "p/b"], { "p/a": NaN, "p/b": "nope" });
    expect(rows).toEqual([
      { model: "p/a", rank: null },
      { model: "p/b", rank: null },
    ]);
  });
});

describe("auto/smart inline score input helpers", () => {
  it("parses valid numeric scores", () => {
    expect(parseScoreInput("7")).toEqual({ kind: "value", value: 7 });
    expect(parseScoreInput(3.5)).toEqual({ kind: "value", value: 3.5 });
    expect(parseScoreInput("  12 ")).toEqual({ kind: "value", value: 12 });
  });

  it("treats blank input as an explicit clear", () => {
    expect(parseScoreInput("")).toEqual({ kind: "empty" });
    expect(parseScoreInput("   ")).toEqual({ kind: "empty" });
    expect(parseScoreInput(null)).toEqual({ kind: "empty" });
    expect(parseScoreInput(undefined)).toEqual({ kind: "empty" });
  });

  it("rejects non-numeric garbage so it cannot silently clear or corrupt a score", () => {
    for (const bad of ["abc", "1e", "Infinity", NaN, Infinity, true, {}, []]) {
      expect(parseScoreInput(bad)).toEqual({ kind: "invalid" });
    }
  });

  it("applies, updates, and clears a model score without mutating the input", () => {
    const base = { "p/a": 1 };
    expect(applyModelScore(base, "p/b", 9)).toEqual({ "p/a": 1, "p/b": 9 });
    expect(applyModelScore({ "p/a": 1, "p/b": 9 }, "p/b", 2)).toEqual({ "p/a": 1, "p/b": 2 });
    expect(applyModelScore({ "p/a": 1, "p/b": 9 }, "p/b", null)).toEqual({ "p/a": 1 });
    expect(base).toEqual({ "p/a": 1 });
  });

  it("resolves the editable row value: saved score until edited, blank clears", () => {
    // No draft yet: show the saved score (an untouched Save must not clear it).
    expect(resolveScoreDraft(undefined, 5)).toBe("5");
    expect(resolveScoreDraft(undefined, null)).toBe("");
    expect(resolveScoreDraft(undefined, undefined)).toBe("");
    // Editing (including blanking) wins over the saved score.
    expect(resolveScoreDraft("9", 5)).toBe("9");
    expect(resolveScoreDraft("", 5)).toBe("");
  });

  it("re-sorts immediately after a successful score change (highest rises to the top)", () => {
    const before = { "p/a": 1, "p/b": 2 };
    const after = applyModelScore(before, "p/a", 100);
    expect(buildRankRows(["p/a", "p/b"], after)).toEqual([
      { model: "p/a", rank: 100 },
      { model: "p/b", rank: 2 },
    ]);
  });
});

describe("auto/smart rank list request gating", () => {
  it("ignores a refresh GET that resolves after a newer mutation began (late GET vs PUT)", () => {
    const gate = createRequestGate();
    const getToken = gate.begin(); // refresh GET is in flight
    gate.begin(); // user Save starts a newer PUT
    expect(gate.isCurrent(getToken)).toBe(false);
  });

  it("accepts only the newest of overlapping requests", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("accepts a refetch that starts after the mutation completed", () => {
    const gate = createRequestGate();
    gate.begin(); // PUT
    const getToken = gate.begin(); // later refresh
    expect(gate.isCurrent(getToken)).toBe(true);
  });

  it("disables score editing while a save or refresh is in flight", () => {
    expect(isRankEditorBusy({ saving: false, refreshing: false })).toBe(false);
    expect(isRankEditorBusy({ saving: true })).toBe(true);
    expect(isRankEditorBusy({ refreshing: true })).toBe(true);
    expect(isRankEditorBusy({})).toBe(false);
  });
});

describe("auto/smart transient-only fallback classification", () => {
  it("falls back for 429 rate limit", () => {
    expect(classifyAutoError({ status: 429, errorText: "rate limit exceeded" }).action).toBe("fallback");
  });

  it("falls back for 5xx and timeout/network failures", () => {
    expect(classifyAutoError({ status: 503, errorText: "service unavailable" }).action).toBe("fallback");
    expect(classifyAutoError({ status: 500, errorText: "internal error" }).action).toBe("fallback");
    expect(classifyAutoError({ status: 0, errorText: "fetch failed: socket hang up" }).action).toBe("fallback");
  });

  it("does not fall back for invalid request, moderation, or context errors", () => {
    expect(classifyAutoError({ status: 400, errorText: "invalid request: bad parameter" }).action).toBe("stop");
    expect(classifyAutoError({ status: 400, errorText: "content filtered by moderation" }).action).toBe("stop");
    expect(classifyAutoError({ status: 400, errorText: "maximum context length exceeded" }).action).toBe("stop");
  });

  it("marks 401/403 as config-error without retry fallback", () => {
    expect(classifyAutoError({ status: 401, errorText: "invalid api key" }).action).toBe("config-error");
    expect(classifyAutoError({ status: 403, errorText: "forbidden" }).action).toBe("config-error");
  });
});

describe("auto/smart exponential cooldown ladder", () => {
  it("uses 1m, 5m, 15m, 30m, max 60m", () => {
    expect(getAutoCooldownMs(1)).toBe(60_000);
    expect(getAutoCooldownMs(2)).toBe(300_000);
    expect(getAutoCooldownMs(3)).toBe(900_000);
    expect(getAutoCooldownMs(4)).toBe(1_800_000);
    expect(getAutoCooldownMs(5)).toBe(3_600_000);
    expect(getAutoCooldownMs(9)).toBe(3_600_000);
  });
});

describe("auto/smart circuit breaker LKGP", () => {
  it("starts later requests directly at LKGP instead of retrying failed higher model", () => {
    const ranked = ["c/model-3", "b/model-2", "a/model-1"];
    const now = Date.now();
    const health = {
      "c/model-3": { failures: 1, cooldownUntil: now + 60_000 },
    };
    const order = buildAutoAttemptOrder(ranked, health, "b/model-2", now, new Set());
    expect(order[0]).toBe("b/model-2");
    expect(order).not.toContain("c/model-3");
  });

  it("reports cooldown vs healthy vs single-flight probing states", () => {
    const now = Date.now();
    const health = {
      "c/model-3": { failures: 1, cooldownUntil: now + 60_000 },
      "b/model-2": { failures: 0, cooldownUntil: 0 },
    };
    expect(getModelState("c/model-3", health, now, new Set())).toBe("cooldown");
    expect(getModelState("b/model-2", health, now, new Set())).toBe("healthy");
    expect(getModelState("b/model-2", health, now, new Set(["b/model-2"]))).toBe("probing");
  });

  it("selects at most one recovery probe for expired higher-ranked models", () => {
    const ranked = ["c/model-3", "b/model-2", "a/model-1"];
    const now = Date.now();
    const health = {
      "c/model-3": { failures: 1, cooldownUntil: now - 1_000 },
    };
    const first = selectProbeCandidate(ranked, health, "b/model-2", now, new Set());
    expect(first).toBe("c/model-3");
    const blocked = selectProbeCandidate(ranked, health, "b/model-2", now, new Set(["c/model-3"]));
    expect(blocked).toBe(null);
  });

  it("gates probe selection on the whole pool, not per model", () => {
    const ranked = ["c/model-3", "b/model-2"];
    const now = Date.now();
    const health = {
      "c/model-3": { failures: 1, cooldownUntil: now - 1_000 },
      "b/model-2": { failures: 1, cooldownUntil: now - 1_000 },
    };
    // A probe in flight for ANY model blocks a second probe for the pool, even
    // though b/model-2 is itself eligible and unlocked.
    expect(selectProbeCandidate(ranked, health, null, now, new Set(["c/model-3"]))).toBe(null);
    expect(selectProbeCandidate(ranked, health, null, now, new Set())).toBe("c/model-3");
  });

  it("failure increments cooldown and success resets health", () => {
    const now = Date.now();
    const failed = recordAutoFailure("c/model-3", {}, now);
    expect(failed["c/model-3"].failures).toBe(1);
    expect(failed["c/model-3"].cooldownUntil).toBe(now + 60_000);
    const reset = recordAutoSuccess("c/model-3", failed);
    expect(reset["c/model-3"].failures).toBe(0);
  });

  it("promotes never-failed higher-ranked models above LKGP without hammering cooling ones", () => {
    const ranked = ["d/model-4", "c/model-3", "b/model-2"];
    const now = Date.now();
    // c failed and is cooling; d is newly ranked above LKGP b and never failed.
    const health = {
      "c/model-3": { failures: 1, cooldownUntil: now + 60_000 },
    };
    const order = buildAutoAttemptOrder(ranked, health, "b/model-2", now, new Set());
    expect(order).toEqual(["d/model-4", "b/model-2"]);
  });

  it("keeps failed-but-expired higher models on the probe path, not the main path", () => {
    const ranked = ["c/model-3", "b/model-2"];
    const now = Date.now();
    const health = {
      "c/model-3": { failures: 2, cooldownUntil: now - 1_000 },
    };
    // Main path serves LKGP only; the expired model is a probe candidate.
    expect(buildAutoAttemptOrder(ranked, health, "b/model-2", now, new Set())).toEqual(["b/model-2"]);
    expect(selectProbeCandidate(ranked, health, "b/model-2", now, new Set())).toBe("c/model-3");
  });

  it("excludes expired failed models from the main path when LKGP is unset", () => {
    const ranked = ["c/model-3", "b/model-2", "a/model-1"];
    const now = Date.now();
    const health = {
      "c/model-3": { failures: 2, cooldownUntil: now - 1_000 },
    };
    // Failed-but-expired candidate must never share the main path with the probe.
    expect(buildAutoAttemptOrder(ranked, health, null, now, new Set())).toEqual(["b/model-2", "a/model-1"]);
    expect(selectProbeCandidate(ranked, health, null, now, new Set())).toBe("c/model-3");
  });

  it("never offers a main-path model that also has a probe in flight", () => {
    const ranked = ["b/model-2", "a/model-1"];
    const now = Date.now();
    const health = {
      "b/model-2": { failures: 1, cooldownUntil: now - 1_000 },
    };
    const inFlight = new Set(["b/model-2"]);
    expect(buildAutoAttemptOrder(ranked, health, null, now, inFlight)).toEqual(["a/model-1"]);
    expect(selectProbeCandidate(ranked, health, null, now, inFlight)).toBe(null);
  });

  it("promotes LKGP only when the candidate outranks the current model", () => {
    const ranks = { "h/m": 10, "l/m": 1 };
    expect(shouldPromoteLkgp(ranks, "h/m", null)).toBe(true);
    expect(shouldPromoteLkgp(ranks, "h/m", "l/m")).toBe(true);
    expect(shouldPromoteLkgp(ranks, "l/m", "h/m")).toBe(false);
    expect(shouldPromoteLkgp(ranks, "h/m", "h/m")).toBe(false);
    // An unranked candidate cannot displace a ranked LKGP.
    expect(shouldPromoteLkgp(ranks, "x/m", "h/m")).toBe(false);
    // Neither unranked: keep the incumbent.
    expect(shouldPromoteLkgp(ranks, "x/m", "y/m")).toBe(false);
  });
});

describe("auto/smart lightweight recovery probe body", () => {
  const sensitive = {
    stream: true,
    temperature: 0.7,
    system: "SECRET SYSTEM PROMPT",
    messages: [
      { role: "system", content: "SECRET SYSTEM PROMPT" },
      { role: "user", content: "SECRET USER PROMPT with api key sk-abc123" },
    ],
    tools: [{ type: "function", function: { name: "secret_tool", description: "SECRET TOOL" } }],
    tool_choice: "auto",
  };

  it("does not duplicate the user prompt, system, or tools", () => {
    const probe = buildAutoProbeBody(sensitive);
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("sk-abc123");
    expect(probe.tools).toBeUndefined();
    expect(probe.tool_choice).toBeUndefined();
    expect(probe.system).toBeUndefined();
  });

  it("stays minimal: non-streaming, tiny token budget, one ping message", () => {
    const probe = buildAutoProbeBody(sensitive);
    expect(probe.stream).toBe(false);
    expect(probe.max_tokens).toBe(1);
    expect(probe.messages).toHaveLength(1);
    expect(probe.messages[0].role).toBe("user");
    expect(String(probe.messages[0].content)).toContain("ping");
  });

  it("preserves the Claude block-content source shape", () => {
    const probe = buildAutoProbeBody({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 4096,
    });
    expect(Array.isArray(probe.messages[0].content)).toBe(true);
    expect(probe.messages[0].content[0]).toMatchObject({ type: "text" });
    expect(probe.max_tokens).toBe(1);
  });

  it("preserves the Responses API input shape", () => {
    const arrayProbe = buildAutoProbeBody({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true });
    expect(Array.isArray(arrayProbe.input)).toBe(true);
    expect(arrayProbe.max_output_tokens).toBe(1);
    expect(arrayProbe.messages).toBeUndefined();

    const stringProbe = buildAutoProbeBody({ input: "hi there", stream: true });
    expect(typeof stringProbe.input).toBe("string");
  });

  it("preserves the Gemini contents shape", () => {
    const probe = buildAutoProbeBody({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(Array.isArray(probe.contents)).toBe(true);
    expect(probe.messages).toBeUndefined();
  });

  it("bounds Gemini and Antigravity output tokens via generationConfig", () => {
    const gemini = buildAutoProbeBody({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(gemini.generationConfig?.maxOutputTokens).toBe(1);

    const antigravity = buildAutoProbeBody({
      request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      userAgent: "antigravity",
    });
    expect(antigravity.request?.generationConfig?.maxOutputTokens).toBe(1);
  });
});

describe("auto/smart ranks payload validation", () => {
  it("accepts a well-formed ranks map and normalizes numeric strings", () => {
    const res = parseRanksPayload({ ranks: { "a/m1": 3, "b/m2": "7" } });
    expect(res.ok).toBe(true);
    expect(res.ranks).toEqual({ "a/m1": 3, "b/m2": 7 });
  });

  it("rejects the entire payload when any rank value is malformed", () => {
    for (const bad of [{ "a/m1": "not-a-number" }, { "a/m1": "" }, { "a/m1": true }, { "a/m1": null }, { "a/m1": [] }]) {
      const res = parseRanksPayload({ ranks: bad });
      expect(res.ok).toBe(false);
      expect(res.ranks).toBeUndefined();
      expect(typeof res.error).toBe("string");
    }
  });

  it("rejects the entire payload when any model key is malformed", () => {
    const res = parseRanksPayload({ ranks: { "a/m1": 1, "no-slash": 2 } });
    expect(res.ok).toBe(false);
    expect(res.ranks).toBeUndefined();
  });

  it("rejects non-object payloads and arrays", () => {
    expect(parseRanksPayload(null).ok).toBe(false);
    expect(parseRanksPayload({ ranks: [] }).ok).toBe(false);
    expect(parseRanksPayload({ ranks: "x" }).ok).toBe(false);
  });

  it("accepts an empty map as an explicit clear", () => {
    const res = parseRanksPayload({ ranks: {} });
    expect(res.ok).toBe(true);
    expect(res.ranks).toEqual({});
  });

  it("trims keys and rejects empty or whitespace-only segments", () => {
    const ok = parseRanksPayload({ ranks: { "  p/m  ": 5 } });
    expect(ok.ok).toBe(true);
    expect(ok.ranks).toEqual({ "p/m": 5 });

    const invalid = ["p/", "/m", "   ", "p/ ", " /m", "p /m", "p/ m", "\t/m", "p/\n"];
    for (const key of invalid) {
      const res = parseRanksPayload({ ranks: { [key]: 1 } });
      expect(res.ok, `expected "${key}" to be rejected`).toBe(false);
      expect(res.ranks).toBeUndefined();
    }
  });

  it("keeps the model segment after the first slash intact (nested ids allowed)", () => {
    const res = parseRanksPayload({ ranks: { "vendor/family/model": 4 } });
    expect(res.ok).toBe(true);
    expect(res.ranks).toEqual({ "vendor/family/model": 4 });
  });
});
