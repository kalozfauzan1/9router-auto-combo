import { describe, it, expect } from "vitest";
import { applyProviderThinking } from "../../open-sse/translator/concerns/providerThinking.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("provider max thinking", () => {
  it("maps mode max to reasoning_effort xhigh without mutating the original body", () => {
    const body = { messages: [] };
    const result = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(result.reasoning_effort).toBe("xhigh");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("resolves max per selected fallback without mutating caller", () => {
    const body = { messages: [] };
    expect(applyProviderThinking(body, { mode: "max" }, "opencode", "deepseek-v4.1-flash-free").reasoning_effort).toBe("max");
    expect(applyProviderThinking(body, { mode: "max" }, "opencode", "glm-5.3-flash-free").reasoning_effort).toBe("xhigh");
    expect(body).toEqual({ messages: [] });
  });

  it.each([
    { reasoning_effort: "low" },
    { reasoning_effort: "none" },
    { reasoning: { effort: "low" } },
    { output_config: { effort: "low" } },
    { thinking: { type: "disabled" } },
    { thinking: { type: "enabled", budget_tokens: 4096 } },
    { generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } },
    { enable_thinking: false },
  ])("keeps explicit reasoning config unchanged: %j", (body) => {
    for (const mode of ["max", "on", "off"]) {
      expect(applyProviderThinking(body, { mode }, "opencode", "mimo-v2.6-free")).toBe(body);
    }
  });

  it("maps mode max to binary thinking for minimax models", () => {
    expect(applyProviderThinking({}, { mode: "max" }, "minimax", "MiniMax-M3").thinking).toEqual({ type: "enabled" });
  });

  it("returns the same body when the model has no reasoning support", () => {
    const body = {};
    expect(applyProviderThinking(body, { mode: "max" }, "openai", "gpt-4o")).toBe(body);
  });

  it("returns the same body when the selected model already carries an effort suffix", () => {
    const body = {};
    expect(applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free(low)")).toBe(body);
  });

  it("maps mode max to reasoning_effort high for high-only providers", () => {
    expect(applyProviderThinking({}, { mode: "max" }, "codebuddy-cn", "hy4-preview").reasoning_effort).toBe("high");
  });

  it.each([
    ["deepseek-v4.1-flash-free", "max"],
    ["glm-5.3-flash-free", "xhigh"],
    ["mimo-v2.6-free", "xhigh"],
  ])("wires max mode for %s to reasoning_effort %s on the openai wire", (model, expected) => {
    const result = applyProviderThinking({ messages: [] }, { mode: "max" }, "opencode", model);
    const wire = applyThinking("openai", model, result, "opencode");
    expect(wire.reasoning_effort).toBe(expected);
    if (model === "glm-5.3-flash-free") {
      expect(wire.thinking).toBeUndefined();
    } else {
      expect(wire.thinking.type).toBe("enabled");
    }
  });

  it("treats auto or missing mode as a no-op and retains on/off/low shapes for empty input", () => {
    const body = { messages: [] };
    const model = "mimo-v2.6-free";

    expect(applyProviderThinking(body, { mode: "auto" }, "opencode", model)).toBe(body);
    expect(applyProviderThinking(body, {}, "opencode", model)).toBe(body);

    const on = applyThinking("openai", model, applyProviderThinking(body, { mode: "on" }, "opencode", model), "opencode");
    expect(on.thinking.type).toBe("enabled");

    const off = applyThinking("openai", model, applyProviderThinking(body, { mode: "off" }, "opencode", model), "opencode");
    // mimo-v2.6-free cannot disable thinking (capability thinkingCanDisable: false), so mode "off"
    // clamps upstream to thinking type "enabled" instead of "disabled".
    expect(off.thinking.type).toBe("enabled");

    const low = applyThinking("openai", model, applyProviderThinking(body, { mode: "low" }, "opencode", model), "opencode");
    // deepseek-format models map low/medium to high on the wire
    expect(low.reasoning_effort).toBe("high");

    expect(applyThinking("openai", "hy4-preview", applyProviderThinking({ messages: [] }, { mode: "low" }, "codebuddy-cn", "hy4-preview"), "codebuddy-cn").reasoning_effort).toBe("low");

    expect(applyThinking("openai", "deepseek-v4-pro", applyProviderThinking({ messages: [] }, { mode: "off" }, "deepseek", "deepseek-v4-pro"), "deepseek").thinking.type).toBe("disabled");
    expect(applyThinking("openai", "claude-opus-4-6", applyProviderThinking({ messages: [] }, { mode: "off" }, "anthropic", "claude-opus-4-6"), "anthropic").reasoning_effort).toBe("none");
    expect(applyThinking("anthropic", "claude-opus-4-6", applyProviderThinking({ messages: [] }, { mode: "off" }, "anthropic", "claude-opus-4-6"), "anthropic").thinking.type).toBe("disabled");
  });
});
