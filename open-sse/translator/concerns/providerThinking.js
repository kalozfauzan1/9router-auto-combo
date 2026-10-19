// Provider-level thinking default (dashboard "Thinking: <mode>" setting).
// Only fills in what the client left unset: an explicit client thinking intent
// (body field or model-name suffix) always wins. Never mutates the input body.

import { extractThinking, parseSuffix } from "./thinkingUnified.js";
import { getThinkingLevels } from "../../providers/thinkingLevels.js";

// Preference order for mode "max": highest genuinely supported level wins.
const MAX_EFFORT_PREFERENCE = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal"];

// applyProviderThinking(body, config, provider, model)
//   config: { mode } from providerSettings.providerThinking[provider]
//   - no config / "auto"      → body unchanged
//   - client set thinking     → body unchanged (all modes)
//   - "max"                   → first model-supported ranked effort; "thinking"-only
//                               formats get thinking:{type:"enabled"}; no levels → unchanged
//   - "on" / "off"            → thinking:{type:"enabled",budget_tokens:10000} / {type:"disabled"}
//   - other modes             → reasoning_effort:<mode>
export function applyProviderThinking(body, config, provider, model) {
  if (!body || typeof body !== "object") return body;
  if (!config?.mode || config.mode === "auto") return body;

  // Preserve all explicit client thinking for every mode.
  if (extractThinking(body) || parseSuffix(model).override) return body;

  const mode = config.mode;
  if (mode === "max") {
    const { cleanModel } = parseSuffix(model);
    const levels = getThinkingLevels(provider, cleanModel);
    if (!Array.isArray(levels) || levels.length === 0) return body;
    const effort = MAX_EFFORT_PREFERENCE.find((level) => levels.includes(level));
    if (effort) return { ...body, reasoning_effort: effort };
    if (levels.includes("thinking")) return { ...body, thinking: { type: "enabled" } };
    return body;
  }
  if (mode === "on") return { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
  if (mode === "off") return { ...body, thinking: { type: "disabled" } };
  return { ...body, reasoning_effort: mode };
}
