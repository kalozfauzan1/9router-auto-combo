import { describe, it, expect } from "vitest";
import { applyProviderThinking } from "../../open-sse/translator/concerns/providerThinking.js";
import { applyThinking, extractThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

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
    { body: { reasoning_effort: "low" }, explicitOff: false },
    { body: { reasoning_effort: "none" }, explicitOff: true },
    { body: { reasoning: { effort: "low" } }, explicitOff: false },
    { body: { output_config: { effort: "low" } }, explicitOff: false },
    { body: { thinking: { type: "disabled" } }, explicitOff: true },
    { body: { thinking: { type: "enabled", budget_tokens: 4096 } }, explicitOff: false },
    { body: { generationConfig: { thinkingConfig: { thinkingBudget: 2048 } } }, explicitOff: false },
    { body: { enable_thinking: false }, explicitOff: true },
  ])("raises lower client to floor without mutating source: %j", ({ body }) => {
    const before = JSON.parse(JSON.stringify(body));

    const maxResult = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(maxResult.reasoning_effort).toBe("xhigh");
    expect(body).toEqual(before);

    // Mode "off" leaves every listed shape untouched, including explicit-off inputs.
    const offResult = applyProviderThinking(body, { mode: "off" }, "opencode", "mimo-v2.6-free");
    expect(offResult).toBe(body);
  });

  it("maps mode max to binary thinking for minimax models", () => {
    expect(applyProviderThinking({}, { mode: "max" }, "minimax", "MiniMax-M3").thinking).toEqual({ type: "enabled" });
  });

  it("returns the same body when the model has no reasoning support", () => {
    const body = {};
    expect(applyProviderThinking(body, { mode: "max" }, "openai", "gpt-4o")).toBe(body);
  });

  it("strict suffix floor raises suffixed low to xhigh", () => {
    expect(applyProviderThinking({}, { mode: "max" }, "opencode", "mimo-v2.6-free(low)").reasoning_effort).toBe("xhigh");
  });

  it("keeps suffix xhigh unchanged against provider high floor", () => {
    const body = {};
    expect(applyProviderThinking(body, { mode: "high" }, "opencode", "mimo-v2.6-free(xhigh)")).toBe(body);
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

  it("strict provider floor raises lower client high", () => {
    expect(applyProviderThinking({ reasoning_effort: "high" }, { mode: "max" }, "opencode", "deepseek-v4.1-flash-free").reasoning_effort).toBe("max");
  });

  it("raises shared original reasoning high across fallbacks without mutating source", () => {
    const body = { reasoning_effort: "high" };
    expect(applyProviderThinking(body, { mode: "max" }, "opencode", "deepseek-v4.1-flash-free").reasoning_effort).toBe("max");
    expect(applyProviderThinking(body, { mode: "max" }, "opencode", "glm-5.3-flash-free").reasoning_effort).toBe("xhigh");
    expect(applyProviderThinking(body, { mode: "max" }, "codebuddy-cn", "hy4-preview").reasoning_effort).toBe("high");
    expect(body).toEqual({ reasoning_effort: "high" });
  });

  it("keeps client xhigh unchanged against provider high floor", () => {
    const body = { reasoning_effort: "xhigh" };
    expect(applyProviderThinking(body, { mode: "max" }, "codebuddy-cn", "hy4-preview")).toBe(body);
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("keeps equal client high unchanged and matching the default high reference", () => {
    const reference = applyProviderThinking({}, { mode: "max" }, "codebuddy-cn", "hy4-preview");
    expect(reference.reasoning_effort).toBe("high");

    const body = { reasoning_effort: "high" };
    const result = applyProviderThinking(body, { mode: "max" }, "codebuddy-cn", "hy4-preview");
    expect(result).toBe(body);
    expect(result.reasoning_effort).toBe(reference.reasoning_effort);
  });

  it("keeps client budget 32768 unchanged against provider high floor", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 32768 } };
    expect(applyProviderThinking(body, { mode: "max" }, "codebuddy-cn", "hy4-preview")).toBe(body);
    expect(body.thinking.budget_tokens).toBe(32768);
  });

  it("upgrades output_config effort low so extractThinking reports xhigh", () => {
    const result = applyProviderThinking({ output_config: { effort: "low" } }, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(extractThinking(result)?.level).toBe("xhigh");
  });

  it("retains unrelated nested output_config fields when raising effort", () => {
    const body = { output_config: { effort: "low", channel: "combo", retries: 2 } };
    const result = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(result.reasoning_effort).toBe("xhigh");
    expect(result.output_config.effort).toBeUndefined();
    expect(result.output_config).toEqual({ channel: "combo", retries: 2 });
  });

  it("retains reasoning summary and display when raising nested low effort", () => {
    const body = { reasoning: { effort: "low", summary: "auto", display: "raw" } };
    const result = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(result.reasoning_effort).toBe("xhigh");
    expect(result.reasoning.summary).toBe("auto");
    expect(result.reasoning.display).toBe("raw");
    expect(body).toEqual({ reasoning: { effort: "low", summary: "auto", display: "raw" } });
  });

  it("removes disabled enable_thinking when raised and keeps the original unchanged", () => {
    const body = { enable_thinking: false };
    const result = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(result).not.toBe(body);
    expect(result.enable_thinking).toBeUndefined();
    expect(result.reasoning_effort).toBe("xhigh");
    expect(body).toEqual({ enable_thinking: false });
  });

  it("removes top-level thinkingConfig controls when raised and keeps the original unchanged", () => {
    const body = { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } };
    const result = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(result).not.toBe(body);
    expect(result.thinkingConfig).toBeUndefined();
    expect(result.reasoning_effort).toBe("xhigh");
    expect(body).toEqual({ thinkingConfig: { thinkingBudget: 0, includeThoughts: false } });
  });

  it.each(["on", "high", "max"])("mode %s leaves nonreasoning gpt-4o unchanged", (mode) => {
    const body = { messages: [] };
    expect(applyProviderThinking(body, { mode }, "openai", "gpt-4o")).toBe(body);
    expect(body).toEqual({ messages: [] });
  });

  it("removes explicit-off thinkingConfig budget 0 when raised to max and keeps the original unchanged", () => {
    const body = { thinkingConfig: { thinkingBudget: 0 } };
    const result = applyProviderThinking(body, { mode: "max" }, "opencode", "mimo-v2.6-free");
    expect(result.thinkingConfig).toBeUndefined();
    expect(body.thinkingConfig.thinkingBudget).toBe(0);
  });
});
