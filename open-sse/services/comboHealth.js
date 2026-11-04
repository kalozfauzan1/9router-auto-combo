const MIN_COOLDOWN_MS = 300000;

const isConcreteMember = (model) => typeof model === "string" && model.includes("/");

/** Keep failed concrete members out of normal traffic until a probe clears them. */
export function buildComboAttemptOrder(models, health = {}, lkgp = null, now = Date.now()) {
  const eligible = models.filter((model) => !isConcreteMember(model) || !(health[model]?.failures > 0));
  if (isConcreteMember(lkgp) && eligible.includes(lkgp)) {
    return [lkgp, ...eligible.filter((model) => model !== lkgp)];
  }
  return eligible;
}

/** Select one expired failure in ranked order, never a virtual combo member. */
export function selectComboProbeCandidate(models, health = {}, now = Date.now()) {
  return models.find((model) => isConcreteMember(model)
    && health[model]?.failures > 0
    && health[model].cooldownUntil <= now) ?? null;
}

/** Record a failure without shortening an existing cooldown or mutating state. */
export function nextComboFailure(previous = {}, options = {}) {
  const { now = Date.now(), retryAfterMs } = options;
  const retryDelay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  const previousDeadline = Number.isFinite(previous.cooldownUntil) ? previous.cooldownUntil : 0;
  return {
    ...previous,
    failures: (previous.failures || 0) + 1,
    cooldownUntil: Math.max(previousDeadline, now + MIN_COOLDOWN_MS, now + retryDelay),
  };
}

/** Convert Retry-After delta seconds or an HTTP date to a nonnegative delay. */
export function parseComboRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const text = String(value).trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const deadline = Date.parse(text);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
}

const text = (value) => typeof value === "string" && value.trim().length > 0;
function usableBlock(block) {
  return ((block?.type === "text" || block?.type === "output_text") && text(block.text))
    || (block?.type === "tool_use" && text(block.name) && block.input != null);
}
export function usableComboPayload(payload) {
  return payload?.choices?.some(({ message }) => text(message?.content)
    || (Array.isArray(message?.content) && message.content.some(usableBlock))
    || message?.tool_calls?.some((call) => text(call?.function?.name) && text(call.function.arguments)))
    || payload?.content?.some?.(usableBlock)
    || payload?.output?.some?.((item) => (item.type === "function_call" && text(item.name) && text(item.arguments))
      || item.content?.some?.(usableBlock))
    || payload?.candidates?.some?.((candidate) => candidate.content?.parts?.some?.((part) => text(part.text)
      || (text(part.functionCall?.name) && part.functionCall.args != null)));
}
