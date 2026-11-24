import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { getDeactivatedProviderIds } from "@/shared/utils/connectionStatus.js";
import { buildModelGroups } from "@/shared/utils/selectableModels.js";

describe("getDeactivatedProviderIds", () => {
  it("identifies providers with connections where all are isActive === false", () => {
    const connections = [
      { provider: "openai-compatible-chat-1", name: "Conn 1", isActive: false },
      { provider: "openai-compatible-chat-1", name: "Conn 2", isActive: false },
      { provider: "gemini", name: "Gemini 1", isActive: false },
    ];
    const deactivated = getDeactivatedProviderIds(connections);
    expect(deactivated.has("openai-compatible-chat-1")).toBe(true);
    expect(deactivated.has("gemini")).toBe(true);
    expect(deactivated.size).toBe(2);
  });

  it("does not deactivate provider if at least one connection is active", () => {
    const connections = [
      { provider: "openai-compatible-chat-1", name: "Conn 1", isActive: false },
      { provider: "openai-compatible-chat-1", name: "Conn 2", isActive: true },
      { provider: "anthropic", name: "Anthropic 1", isActive: true },
    ];
    const deactivated = getDeactivatedProviderIds(connections);
    expect(deactivated.has("openai-compatible-chat-1")).toBe(false);
    expect(deactivated.has("anthropic")).toBe(false);
    expect(deactivated.size).toBe(0);
  });

  it("does not deactivate providers with 0 connections (e.g. keyless local Ollama)", () => {
    const connections = [
      { provider: "other-provider", name: "Other", isActive: false },
    ];
    const deactivated = getDeactivatedProviderIds(connections);
    // Provider not in connections array is not considered deactivated
    expect(deactivated.has("local-ollama-node")).toBe(false);
  });

  it("handles empty or null connections list safely", () => {
    expect(getDeactivatedProviderIds([]).size).toBe(0);
    expect(getDeactivatedProviderIds(null).size).toBe(0);
    expect(getDeactivatedProviderIds(undefined).size).toBe(0);
  });
});

describe("buildModelGroups with deactivated providers", () => {
  const provider = "openai-compatible-chat-1";
  const providerNodes = [{ id: provider, prefix: "local" }];
  const customModels = [{ providerAlias: provider, id: "chat-model" }];
  const inactive = { provider, isActive: false };

  it("offers a keyless compatible node only when it is not paused", () => {
    const inputs = { connections: [], providerNodes, customModels };
    expect(buildModelGroups(inputs)[provider]?.models).toEqual([
      expect.objectContaining({ value: "local/chat-model", isCustom: true }),
    ]);
    expect(buildModelGroups({ ...inputs, allConnections: [inactive] })[provider]).toBeUndefined();
  });

  it("keeps a compatible node visible when another connection is active", () => {
    const active = { provider, isActive: true };
    const groups = buildModelGroups({
      connections: [active],
      allConnections: [inactive, active],
      providerNodes,
      customModels,
    });
    expect(groups[provider]?.models.map((model) => model.value)).toEqual(["local/chat-model"]);
  });

  it("does not reintroduce a paused no-auth provider through its custom models", () => {
    const inputs = {
      connections: [],
      customModels: [{ providerAlias: "oc", id: "local-custom", kind: "llm" }],
    };
    expect(buildModelGroups(inputs).opencode?.models).toContainEqual(
      expect.objectContaining({ value: "oc/local-custom", isCustom: true }),
    );
    const groups = buildModelGroups({
      ...inputs,
      allConnections: [{ provider: "opencode", isActive: false }],
    });
    expect(groups.opencode).toBeUndefined();
  });
});

describe("ModelSelectModal source verification", () => {
  it("fetches /api/providers on modal open", () => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    const src = fs.readFileSync(fileUrl, "utf-8");
    expect(src).toContain('fetch("/api/providers")');
  });
});
