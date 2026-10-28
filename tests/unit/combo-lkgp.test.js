import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("combo LKGP (toggle-gated)", () => {
  let singleModelMock;
  let successes;

  beforeEach(() => {
    successes = [];
    singleModelMock = vi.fn(async (body, model) => {
      if (model === "alias/bad") {
        return { ok: false, status: 503, statusText: "unavailable" };
      }
      return { ok: true, status: 200, headers: new Headers({ "content-type": "text/plain" }), body: null };
    });
  });

  it("does not reorder when comboLkgp is null", async () => {
    const models = ["alias/bad", "alias/good"];
    // alias/good succeeds on first try anyway; test ordering preserved by mock
    const res = await handleComboChat({
      body: {},
      models,
      handleSingleModel: singleModelMock,
      log: { info: () => {}, warn: () => {} },
      comboName: "test",
      comboStrategy: "fallback",
    });
    expect(res.status).toBe(200);
    expect(singleModelMock.mock.calls[0][1]).toBe("alias/bad");
  });

  it("pins comboLkgp to front when provided", async () => {
    const models = ["alias/bad", "alias/good"];
    const res = await handleComboChat({
      body: {},
      models,
      handleSingleModel: singleModelMock,
      log: { info: () => {}, warn: () => {} },
      comboName: "test",
      comboStrategy: "fallback",
      comboLkgp: "alias/good",
      noteComboSuccess: async (m) => { successes.push(m); },
    });
    expect(res.status).toBe(200);
    expect(singleModelMock.mock.calls[0][1]).toBe("alias/good");
    expect(successes).toContain("alias/good");
  });

  it("clears LKGP on all-fail", async () => {
    const cleared = [];
    const allBad = vi.fn(async () => ({ ok: false, status: 503, statusText: "unavailable" }));
    const res = await handleComboChat({
      body: {},
      models: ["alias/bad", "alias/bad2"],
      handleSingleModel: allBad,
      log: { info: () => {}, warn: () => {} },
      comboName: "test",
      comboStrategy: "fallback",
      comboLkgp: "alias/bad",
      clearComboLkgp: async () => { cleared.push("cleared"); },
    });
    expect(res.status).toBe(503);
    expect(cleared).toContain("cleared");
  });

  it("ignores comboLkgp not in models list", async () => {
    const models = ["alias/bad", "alias/good"];
    const res = await handleComboChat({
      body: {},
      models,
      handleSingleModel: singleModelMock,
      log: { info: () => {}, warn: () => {} },
      comboName: "test",
      comboStrategy: "fallback",
      comboLkgp: "alias/not-in-list",
    });
    expect(singleModelMock.mock.calls[0][1]).toBe("alias/bad");
  });
});
