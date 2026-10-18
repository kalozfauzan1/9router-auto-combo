import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// glm-5.3-flash-free on the OpenCode free lanes (opencode / opencode-zen) is
// served by an OpenAI-compatible upstream that rejects the z.ai `thinking`
// object (unknown field). It must speak OpenAI reasoning_effort there, while
// the native glm glm-5.3-flash stays on the zai wire format.

const FREE_PROVIDERS = ["opencode", "opencode-zen"];
const MODEL = "glm-5.3-flash-free";

describe("glm-5.3-flash-free thinking format on the OpenCode free lanes", () => {
  it.each(FREE_PROVIDERS)("%s: applyThinking keeps reasoning_effort high and adds no thinking object", (provider) => {
    const body = { reasoning_effort: "high" };
    applyThinking("openai", MODEL, body, provider);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toBeUndefined();
  });

  it.each(FREE_PROVIDERS)("%s: resolves an openai thinkingFormat", (provider) => {
    const caps = getCapabilitiesForModel(provider, MODEL);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it.each(FREE_PROVIDERS)("%s: offers high, not thinking/none", (provider) => {
    const levels = getThinkingLevels(provider, MODEL);
    expect(levels).toContain("high");
    expect(levels).not.toContain("thinking");
    expect(levels).not.toContain("none");
  });

  it("native glm/glm-5.3-flash stays on the zai wire format", () => {
    expect(getCapabilitiesForModel("glm", "glm-5.3-flash").thinkingFormat).toBe("zai");
    const body = { reasoning_effort: "high" };
    applyThinking("openai", "glm-5.3-flash", body, "glm");
    expect(body.thinking).toEqual({ type: "enabled" });
  });
});
