import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities, reorderByCapabilities } from "../../open-sse/services/combo.js";

describe("detectRequiredCapabilities", () => {
  it("text-only -> empty", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: "hi" }] });
    expect(r.size).toBe(0);
  });

  it("openai image_url -> vision", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "x" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });

  it("openai file -> pdf", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "file", file: { file_data: "data:application/pdf;base64,x" } },
    ] }] });
    expect(r.has("pdf")).toBe(true);
  });

  it("gemini inlineData image -> vision", () => {
    const r = detectRequiredCapabilities({ contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });

  it("antigravity request.contents image -> vision", () => {
    const r = detectRequiredCapabilities({ request: { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: "x" } },
    ] }] } });
    expect(r.has("vision")).toBe(true);
  });

  it("web_search alone leaves search auto-switch disabled", () => {
    // Search auto-switch is intentionally disabled: the feature is not wired yet.
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: "q" }], tools: [
      { type: "web_search" },
    ] });
    expect([...r]).toEqual([]);
  });

  it("image plus web_search detects vision without enabling search auto-switch", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "x" } },
    ] }], tools: [{ type: "web_search" }] });
    expect([...r]).toEqual(["vision"]);
  });

  it("responses input_image -> vision", () => {
    const r = detectRequiredCapabilities({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "x" },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });
});

describe("reorderByCapabilities", () => {
  it("no required -> unchanged", () => {
    const models = ["a/x", "b/y"];
    expect(reorderByCapabilities(models, new Set())).toBe(models);
  });

  it("floats vision-capable model to front, keeps fallback", () => {
    // deepseek-chat = no vision; claude-sonnet = vision
    const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out[0]).toBe("anthropic/claude-sonnet-4.6");
    expect(out).toContain("deepseek/deepseek-chat"); // not dropped
    expect(out).toHaveLength(2);
  });

  it("keeps order when no model matches", () => {
    const models = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out).toBe(models);
  });

  it("preserves identity and input for already ordered mixed capabilities", () => {
    const expected = [
      "anthropic/claude-sonnet-4.6", "opencode-go/mimo-v2.5",
      "deepseek/deepseek-chat", "deepseek/deepseek-reasoner",
    ];
    const models = Object.freeze([...expected]);
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out).toBe(models);
    expect(out).toEqual(expected);
    expect(models).toEqual(expected);
  });

  it("stably prioritizes matching models without mutating or dropping fallbacks", () => {
    const expectedInput = [
      "deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6",
      "deepseek/deepseek-reasoner", "opencode-go/mimo-v2.5",
    ];
    const models = Object.freeze([...expectedInput]);
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out).not.toBe(models);
    expect(out).toEqual([
      expectedInput[1], expectedInput[3], expectedInput[0], expectedInput[2],
    ]);
    expect(models).toEqual(expectedInput);
  });

  it("single model -> unchanged", () => {
    const models = ["a/x"];
    expect(reorderByCapabilities(models, new Set(["vision"]))).toBe(models);
  });
});
