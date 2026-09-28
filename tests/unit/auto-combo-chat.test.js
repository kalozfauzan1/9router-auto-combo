import { describe, it, expect, vi, beforeEach } from "vitest";

import { handleAutoComboChat, getProbeInFlight } from "../../src/sse/services/autoComboService.js";

function errRes(status, message) {
  return {
    ok: false,
    status,
    statusText: message,
    clone: () => Promise.resolve({ json: async () => ({ error: { message } }) }),
    headers: {},
  };
}

function okRes(model) {
  return { ok: true, status: 200, model, headers: {} };
}

function baseDeps(overrides = {}) {
  return {
    loadRanked: async () => ["p/top", "p/low"],
    loadHealth: async () => ({}),
    loadLkgp: async () => null,
    noteFailure: vi.fn(async () => {}),
    noteSuccess: vi.fn(async () => {}),
    noteLkgp: vi.fn(async () => {}),
    disableModel: vi.fn(async () => {}),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

const quiet = { info: () => {}, warn: () => {} };

beforeEach(() => {
  getProbeInFlight().clear();
});

describe("handleAutoComboChat transient fallback", () => {
  it("falls back to the next model and records failure + LKGP", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push(model);
      return model === "p/top" ? errRes(500, "internal error") : okRes(model);
    });
    const deps = baseDeps();
    const out = await handleAutoComboChat({
      body: { messages: [] },
      handleSingleModel,
      log: quiet,
      comboName: "auto",
      deps,
    });
    expect(calls).toEqual(["p/top", "p/low"]);
    expect(out).toMatchObject({ ok: true, model: "p/low" });
    // Failure is recorded by model key only — no stale-snapshot math in the path.
    expect(deps.noteFailure.mock.calls).toEqual([["p/top"]]);
    expect(deps.noteSuccess.mock.calls).toEqual([["p/low"]]);
    expect(deps.noteLkgp.mock.calls).toEqual([["p/low"]]);
  });
});

describe("handleAutoComboChat auth/config errors", () => {
  it("stops on 401, persists config-error state, returns the original error", async () => {
    const first = errRes(401, "invalid api key");
    const handleSingleModel = vi.fn(async () => first);
    const deps = baseDeps();
    const out = await handleAutoComboChat({
      body: { messages: [] },
      handleSingleModel,
      log: quiet,
      comboName: "auto",
      deps,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(out).toBe(first);
    expect(deps.disableModel.mock.calls).toEqual([["p/top"]]);
    expect(deps.noteFailure).not.toHaveBeenCalled();
  });
});

describe("handleAutoComboChat all-cooling circuits", () => {
  it("returns 503 without touching any model when no circuit is closed", async () => {
    const handleSingleModel = vi.fn(async () => okRes("p/top"));
    const deps = baseDeps({
      loadHealth: async () => ({
        "p/top": { failures: 1, cooldownUntil: 1_700_000_000_000 + 60_000 },
        "p/low": { failures: 2, cooldownUntil: 1_700_000_000_000 + 300_000 },
      }),
      loadLkgp: async () => "p/top",
    });
    const out = await handleAutoComboChat({
      body: { messages: [] },
      handleSingleModel,
      log: quiet,
      comboName: "auto",
      deps,
    });
    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(out.status).toBe(503);
    expect(await out.json()).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/no healthy/i) }) });
  });
});

describe("handleAutoComboChat LKGP-less expired circuit", () => {
  it("serves a healthy lower model and only probes the expired failed one", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push(model);
      return okRes(model);
    });
    const deps = baseDeps({
      loadHealth: async () => ({
        "p/top": { failures: 2, cooldownUntil: 1_700_000_000_000 - 1_000 },
      }),
      loadLkgp: async () => null,
    });
    const out = await handleAutoComboChat({
      body: { messages: [] },
      handleSingleModel,
      log: quiet,
      comboName: "auto",
      deps,
    });
    expect(out).toMatchObject({ ok: true, model: "p/low" });
    expect(calls[0]).toBe("p/low");
    await new Promise((r) => setTimeout(r, 20));
    // The expired model is reached only by the single guarded probe, never by
    // the main path (so a user request and a probe never hit it concurrently).
    expect(calls.filter((m) => m === "p/top")).toHaveLength(1);
    expect(getProbeInFlight().size).toBe(0);
  });
});

describe("handleAutoComboChat all-expired circuit recovery", () => {
  it("runs exactly one probe while main order is empty, 503s, then recovers", async () => {
    const NOW = 1_700_000_000_000;
    let lkgp = null;
    const health = { "p/top": { failures: 1, cooldownUntil: NOW - 1_000 } };
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push(model);
      return okRes(model);
    });
    let noteSuccessCount = 0;
    const deps = baseDeps({
      loadRanked: async () => ["p/top"],
      now: () => NOW,
      loadHealth: async () => ({ ...health }),
      loadLkgp: async () => lkgp,
      noteSuccess: vi.fn(async (m) => {
        noteSuccessCount++;
        health[m] = { failures: 0, cooldownUntil: 0 };
      }),
      noteLkgp: vi.fn(async (m) => { lkgp = m; }),
    });

    // Two concurrent requests hit the all-expired pool simultaneously.
    const [r1, r2] = await Promise.all([
      handleAutoComboChat({ body: { messages: [] }, handleSingleModel, log: quiet, comboName: "auto", deps }),
      handleAutoComboChat({ body: { messages: [] }, handleSingleModel, log: quiet, comboName: "auto", deps }),
    ]);
    // Current requests take the safe 503 — no user request reaches the failed model.
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    await new Promise((r) => setTimeout(r, 20));

    // Exactly one recovery probe fired despite two requests (single-probe lock).
    expect(calls.filter((m) => m === "p/top")).toHaveLength(1);
    expect(noteSuccessCount).toBe(1);
    expect(deps.noteLkgp.mock.calls).toEqual([["p/top"]]);
    expect(getProbeInFlight().size).toBe(0);

    // Recovery took effect: the next request routes to the recovered model.
    calls.length = 0;
    const r3 = await handleAutoComboChat({ body: { messages: [] }, handleSingleModel, log: quiet, comboName: "auto", deps });
    expect(r3).toMatchObject({ ok: true, model: "p/top" });
    expect(calls[0]).toBe("p/top");
  });
});

describe("handleAutoComboChat pool-scoped probe lock", () => {
  it("allows only one probe total across multiple expired failed models", async () => {
    const NOW = 1_700_000_000_000;
    let lkgp = null;
    const health = {
      "p/top": { failures: 1, cooldownUntil: NOW - 1_000 },
      "p/mid": { failures: 2, cooldownUntil: NOW - 2_000 },
      "p/low": { failures: 1, cooldownUntil: NOW - 3_000 },
    };
    const probeCalls = [];
    const bodies = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      probeCalls.push(model);
      bodies.push(body);
      return okRes(model);
    });
    const deps = baseDeps({
      loadRanked: async () => ["p/top", "p/mid", "p/low"],
      now: () => NOW,
      loadHealth: async () => ({ ...health }),
      loadLkgp: async () => lkgp,
      noteSuccess: vi.fn(async (m) => { health[m] = { failures: 0, cooldownUntil: 0 }; }),
      noteLkgp: vi.fn(async (m) => { lkgp = m; }),
    });

    // Concurrent auto + smart alias requests, all circuits expired.
    const results = await Promise.all([
      handleAutoComboChat({ body: { messages: [{ role: "user", content: "USER-ONE" }] }, handleSingleModel, log: quiet, comboName: "auto", deps }),
      handleAutoComboChat({ body: { messages: [{ role: "user", content: "USER-TWO" }] }, handleSingleModel, log: quiet, comboName: "smart", deps }),
      handleAutoComboChat({ body: { messages: [{ role: "user", content: "USER-THREE" }] }, handleSingleModel, log: quiet, comboName: "auto", deps }),
    ]);
    expect(results.every((r) => r.status === 503)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    // Exactly one probe total (pool-scoped lock shared by auto/smart), highest
    // ranked eligible model, and no user body reached any failed model.
    expect(probeCalls).toEqual(["p/top"]);
    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain("USER-ONE");
    expect(serialized).not.toContain("USER-TWO");
    expect(serialized).not.toContain("USER-THREE");
    expect(getProbeInFlight().size).toBe(0);

    // Recovery: subsequent request routes to the recovered model on the main path.
    probeCalls.length = 0;
    const r = await handleAutoComboChat({ body: { messages: [] }, handleSingleModel, log: quiet, comboName: "auto", deps });
    expect(r).toMatchObject({ ok: true, model: "p/top" });
    expect(probeCalls[0]).toBe("p/top");
  });
});

describe("handleAutoComboChat recovery probe", () => {
  it("promotes an expired higher model back to LKGP on probe success", async () => {
    const calls = [];
    const bodies = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push(model);
      bodies.push({ model, body });
      return okRes(model);
    });
    const deps = baseDeps({
      loadHealth: async () => ({
        "p/top": { failures: 1, cooldownUntil: 1_700_000_000_000 - 1_000 },
      }),
      loadLkgp: async () => "p/low",
    });
    const out = await handleAutoComboChat({
      body: { messages: [{ role: "user", content: "SECRET-PROMPT" }], tools: [{ type: "function", function: { name: "t" } }] },
      handleSingleModel,
      log: quiet,
      comboName: "auto",
      deps,
    });
    // Main path serves LKGP immediately.
    expect(out).toMatchObject({ ok: true, model: "p/low" });
    expect(calls[0]).toBe("p/low");
    // The guarded probe still tests the expired higher model in background.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("p/top");
    expect(deps.noteLkgp.mock.calls).toContainEqual(["p/top"]);
    // Probe body is sanitized: no user prompt/tools, minimal budget, non-stream.
    const probe = bodies.find((b) => b.model === "p/top");
    expect(JSON.stringify(probe.body)).not.toContain("SECRET-PROMPT");
    expect(probe.body.tools).toBeUndefined();
    expect(probe.body.stream).toBe(false);
    expect(probe.body.max_tokens).toBe(1);
    expect(getProbeInFlight().size).toBe(0);
  });
});
