// Provider-level thinking default (dashboard "Thinking: <mode>" setting).
// Strict floor includes the model-name suffix: only raises a client's intent
// (suffix override or body-level effort) to the provider default. A lower
// intent gets raised; a higher/equal one stays untouched. Never mutates the
// input body.

import { extractThinking, parseSuffix } from "./thinkingUnified.js";
import { budgetToLevel } from "./thinking.js";
import { getThinkingLevels } from "../../providers/thinkingLevels.js";

// Preference order for mode "max": highest genuinely supported level wins.
const MAX_EFFORT_PREFERENCE = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal"];

const LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const THINKING_BUDGET = 10000;

function levelRank(level) {
  const rank = LEVEL_ORDER.indexOf(level);
  return rank === -1 ? null : rank;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clientLevel(thinking) {
  if (!thinking) return null;
  if (thinking.mode === "none") return "none";
  if (thinking.mode === "level") return thinking.level;
  if (thinking.mode === "budget") return budgetToLevel(thinking.budget) ?? null;
  return null;
}

// Resolve the provider's thinking body without touching the client body.
function resolveProviderThinking(mode, provider, model) {
  if (mode === "max") {
    const { cleanModel } = parseSuffix(model);
    const levels = getThinkingLevels(provider, cleanModel);
    if (!Array.isArray(levels) || levels.length === 0) return null;
    const effort = MAX_EFFORT_PREFERENCE.find((level) => levels.includes(level));
    if (effort) return { level: effort, body: { reasoning_effort: effort } };
    if (levels.includes("thinking")) {
      return { level: "max", body: { thinking: { type: "enabled" } } };
    }
    return null;
  }
  if (mode === "on") {
    return {
      level: budgetToLevel(THINKING_BUDGET) ?? null,
      body: { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET } },
    };
  }
  if (mode === "off") {
    return { level: "none", body: { thinking: { type: "disabled" } } };
  }
  return { level: mode, body: { reasoning_effort: mode } };
}

// Remove client thinking controls while preserving unrelated nested fields
// (for example reasoning.summary / reasoning.display).
function withoutThinkingControls(body) {
  const next = { ...body };
  delete next.reasoning_effort;

  if (isPlainObject(body.reasoning)) {
    const controls = ["effort", "enabled", "max_tokens", "budget_tokens", "budgetTokens"];
    if (controls.some((key) => key in body.reasoning)) {
      const reasoning = { ...body.reasoning };
      for (const key of controls) delete reasoning[key];
      if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
      else delete next.reasoning;
    }
  }

  if (isPlainObject(body.thinking)) {
    const controls = ["type", "budget_tokens", "budgetTokens", "budget"];
    if (controls.some((key) => key in body.thinking)) {
      const thinking = { ...body.thinking };
      for (const key of controls) delete thinking[key];
      if (Object.keys(thinking).length > 0) next.thinking = thinking;
      else delete next.thinking;
    }
  } else if ("thinking" in body) {
    delete next.thinking;
  }

  if (isPlainObject(body.params)) {
    const controls = ["reasoning_effort", "thinking"];
    if (controls.some((key) => key in body.params)) {
      const params = { ...body.params };
      for (const key of controls) delete params[key];
      if (Object.keys(params).length > 0) next.params = params;
      else delete next.params;
    }
  }

  // Copy-on-write cleanup of provider-specific thinking control keys so a
  // stale low effort (e.g. output_config.effort) can't override the raised
  // provider default below. Never mutates the original body.
  const nestedControls = [
    ["output_config", ["effort"]],
    ["thinkingConfig", null],
    ["generationConfig", ["thinkingConfig"]],
    ["request", ["generationConfig"]],
  ];
  for (const [key, innerKeys] of nestedControls) {
    if (key === "thinkingConfig") {
      delete next.thinkingConfig;
      continue;
    }
    if (!isPlainObject(body[key])) continue;
    const copy = { ...body[key] };
    let changed = false;
    if (key === "request" && isPlainObject(body.request.generationConfig)) {
      const generationConfig = { ...body.request.generationConfig };
      if ("thinkingConfig" in generationConfig) {
        delete generationConfig.thinkingConfig;
        changed = true;
      }
      if (Object.keys(generationConfig).length > 0) copy.generationConfig = generationConfig;
      else delete copy.generationConfig;
    } else if (innerKeys) {
      for (const inner of innerKeys) {
        if (inner in body[key]) {
          delete copy[inner];
          changed = true;
        }
      }
    }
    if (changed) {
      if (Object.keys(copy).length > 0) next[key] = copy;
      else delete next[key];
    }
  }

  for (const key of ["enable_thinking", "thinking_budget"]) {
    if (key in body) delete next[key];
  }

  return next;
}

function applyProviderBody(body, providerBody) {
  const next = withoutThinkingControls(body);
  if (providerBody.reasoning_effort !== undefined) {
    next.reasoning_effort = providerBody.reasoning_effort;
  }
  if (providerBody.thinking) {
    const existing = isPlainObject(next.thinking) ? next.thinking : {};
    next.thinking = { ...existing, ...providerBody.thinking };
  }
  return next;
}

// applyProviderThinking(body, config, provider, model)
//   config: { mode } from providerSettings.providerThinking[provider]
//   - no config / "auto"          → body unchanged
//   - client effort >= provider (strict floor includes suffix) → body unchanged
//   - otherwise                   → provider thinking body, client controls cleared
export function applyProviderThinking(body, config, provider, model) {
  if (!body || typeof body !== "object") return body;
  if (!config?.mode || config.mode === "auto") return body;

  if (!getThinkingLevels(provider, parseSuffix(model).cleanModel)) return body;

  // Existing rank comparison handles the model-name suffix too: strict floor
  // includes the suffix, so a higher/equal suffix keeps the original body and a
  // lower suffix raises it (chatCore strips the suffix downstream next batch).

  const providerThinking = resolveProviderThinking(config.mode, provider, model);
  if (!providerThinking) return body;

  const suffixOverride = parseSuffix(model).override;

  const clientRank = levelRank(
    clientLevel(suffixOverride || extractThinking(body)),
  );
  const providerRank = levelRank(providerThinking.level);
  if (
    clientRank !== null &&
    providerRank !== null &&
    clientRank >= providerRank
  ) {
    return body;
  }

  return applyProviderBody(body, providerThinking.body);
}
