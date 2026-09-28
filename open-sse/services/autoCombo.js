/**
 * Auto/Smart virtual combo core.
 * Manual intelligence rank semantics: higher number = smarter.
 * Ranked models order highest rank first; unranked models sort last (stable).
 */

export const AUTO_COMBO_NAMES = new Set(["auto", "smart"]);

export function isAutoComboName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const base = trimmed.includes("/") ? null : trimmed.toLowerCase();
  return base !== null && AUTO_COMBO_NAMES.has(base);
}

function rankOf(model, ranks) {
  const v = ranks?.[model];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Deterministic provider/model order used to break ties and order unscored rows. */
function compareModelNames(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * Order models highest rank first (higher number = smarter).
 * Scored models always precede unscored ones; equal scores and unscored models
 * fall back to deterministic provider/model order, so the list is stable across
 * reloads regardless of the input array's order.
 */
export function orderByRank(models, ranks = {}) {
  if (!Array.isArray(models) || models.length <= 1) return models;
  return models
    .map((m, i) => ({ m, i, r: rankOf(m, ranks) }))
    .sort((a, b) => {
      if (a.r === null && b.r === null) return compareModelNames(a.m, b.m);
      if (a.r === null) return 1;
      if (b.r === null) return -1;
      if (b.r !== a.r) return b.r - a.r;
      return compareModelNames(a.m, b.m);
    })
    .map((x) => x.m);
}

/**
 * Build the dashboard rank list: every eligible model as `{ model, rank }`,
 * scored models first (highest score = smartest), equal scores and unscored
 * models ordered deterministically by provider/model, with unscored models
 * always last. `rank` is `null` for an unscored (blank) row.
 */
export function buildRankRows(models, ranks = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const seen = new Set();
  const unique = [];
  for (const m of models) {
    if (typeof m !== "string" || !m.includes("/")) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    unique.push(m);
  }
  return orderByRank(unique, ranks).map((m) => ({ model: m, rank: rankOf(m, ranks) }));
}

/**
 * Parse a raw inline score input.
 * - `{ kind: "value", value }` for a finite number (number or numeric string)
 * - `{ kind: "empty" }` for blank input, which intentionally clears the score
 * - `{ kind: "invalid" }` for non-numeric garbage, so a typo can never silently
 *   clear an existing score or write a corrupt one
 */
export function parseScoreInput(raw) {
  if (raw === null || raw === undefined) return { kind: "empty" };
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { kind: "value", value: raw } : { kind: "invalid" };
  }
  if (typeof raw !== "string") return { kind: "invalid" };
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "empty" };
  const n = Number(trimmed);
  return Number.isFinite(n) ? { kind: "value", value: n } : { kind: "invalid" };
}

/**
 * Return a new ranks map with `model` set to `score`, or with `model` removed
 * when `score` is null/undefined (clear). Never mutates the input.
 */
export function applyModelScore(ranks, model, score) {
  const src = ranks && typeof ranks === "object" && !Array.isArray(ranks) ? ranks : {};
  if (typeof model !== "string" || !model.includes("/")) return { ...src };
  const next = { ...src };
  if (score === null || score === undefined) {
    delete next[model];
    return next;
  }
  const n = typeof score === "number" ? score : Number(score);
  if (Number.isFinite(n)) next[model] = n;
  return next;
}

/**
 * Resolve the value shown in a row's inline score editor. An explicit draft
 * (including an empty string the user blanked out) wins; otherwise fall back to
 * the saved score, or an empty string when the model is unscored.
 */
export function resolveScoreDraft(draft, savedScore) {
  if (draft !== undefined && draft !== null) return draft;
  return savedScore === null || savedScore === undefined ? "" : String(savedScore);
}

/**
 * Monotonic request gate for the rank list. Every GET/PUT takes a token via
 * `begin()`; a response is applied only while its token is still current.
 * Starting a newer request (a save, or a later refresh) invalidates any in-flight
 * fetch, so a late GET can never overwrite a newer successful PUT or roll back
 * drafts the user typed after the GET was issued.
 */
export function createRequestGate() {
  let seq = 0;
  return {
    begin() {
      seq += 1;
      return seq;
    },
    isCurrent(token) {
      return token === seq;
    },
  };
}

/**
 * Whether the inline score editor should be locked. Any in-flight save or refresh
 * disables score inputs and Save/Clear so mutations and refetches stay serialized.
 */
export function isRankEditorBusy({ saving = false, refreshing = false } = {}) {
  return Boolean(saving || refreshing);
}

// Exponential cooldown ladder: 1m, 5m, 15m, 30m, max 60m.
const AUTO_COOLDOWNS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];

export function getAutoCooldownMs(consecutiveFailures) {
  const n = Number(consecutiveFailures);
  if (!Number.isFinite(n) || n <= 1) return AUTO_COOLDOWNS_MS[0];
  const idx = Math.min(Math.floor(n) - 1, AUTO_COOLDOWNS_MS.length - 1);
  return AUTO_COOLDOWNS_MS[idx];
}

const TRANSIENT_TEXT_HINTS = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "quota exhausted",
  "capacity",
  "overloaded",
  "temporarily unavailable",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "timeout",
  "timed out",
  "etimedout",
  "econnreset",
  "econnaborted",
  "socket hang up",
  "fetch failed",
  "network",
  "model unavailable",
  "no capacity",
];

const NON_FALLBACK_TEXT_HINTS = [
  "invalid request",
  "bad request",
  "validation",
  "moderation",
  "content filter",
  "content filtered",
  "safety",
  "blocked by",
  "context length",
  "maximum context",
  "context window",
  "max tokens",
  "too long",
  "unsupported parameter",
  "invalid parameter",
];

/**
 * Classify an auto/smart failure.
 * - config-error: 401/403 auth/config problems (disable from retries, no fallback)
 * - fallback: transient 429/quota/timeout/network/5xx/model-unavailable
 * - stop: invalid request, moderation, context errors and other 4xx
 */
export function classifyAutoError({ status, errorText } = {}) {
  const text = String(errorText || "").toLowerCase();
  const code = Number(status);

  if (code === 401 || code === 403) {
    return { action: "config-error", reason: `auth/config failure (${code})` };
  }

  for (const hint of NON_FALLBACK_TEXT_HINTS) {
    if (hint && text.includes(hint)) return { action: "stop", reason: hint };
  }

  if (code === 429) return { action: "fallback", reason: "rate limited" };
  if ([408, 425, 500, 502, 503, 504].includes(code)) {
    return { action: "fallback", reason: `transient status ${code}` };
  }
  if (!code || code === 0) {
    for (const hint of TRANSIENT_TEXT_HINTS) {
      if (hint && text.includes(hint)) return { action: "fallback", reason: hint };
    }
    if (!text) return { action: "fallback", reason: "network failure" };
    return { action: "stop", reason: "unknown failure without status" };
  }

  for (const hint of TRANSIENT_TEXT_HINTS) {
    if (hint && text.includes(hint)) return { action: "fallback", reason: hint };
  }

  if (code >= 400 && code < 500) return { action: "stop", reason: `client error ${code}` };
  return { action: "fallback", reason: "transient" };
}

export function getModelState(model, health = {}, now = Date.now(), probeInFlight = new Set()) {
  if (probeInFlight && typeof probeInFlight.has === "function" && probeInFlight.has(model)) {
    return "probing";
  }
  const entry = health?.[model];
  if (!entry) return "healthy";
  const until = Number(entry.cooldownUntil) || 0;
  if (until > now) return "cooldown";
  return "healthy";
}

export function recordAutoFailure(model, health = {}, now = Date.now()) {
  const prev = health?.[model] || { failures: 0, cooldownUntil: 0 };
  const failures = (Number(prev.failures) || 0) + 1;
  return {
    ...health,
    [model]: { failures, cooldownUntil: now + getAutoCooldownMs(failures) },
  };
}

export function recordAutoSuccess(model, health = {}) {
  if (!health?.[model]) return { ...health };
  return {
    ...health,
    [model]: { failures: 0, cooldownUntil: 0 },
  };
}

/**
 * A model may serve the main path only if it has never failed (no failure
 * record) and its circuit is closed. Failed-but-expired models are left to the
 * single guarded probe so a user request and a probe never hit the same model.
 */
function isMainPathEligible(model, health, now, probeInFlight) {
  const entry = health?.[model];
  if (entry && (Number(entry.failures) || 0) > 0) return false;
  return getModelState(model, health, now, probeInFlight) === "healthy";
}

/**
 * Build the main-path attempt order for one request.
 * Starts directly at LKGP (no retry of known-failed higher models), then goes
 * down the ranking. Skips models in cooldown, failed models awaiting/expired
 * from cooldown (probe-eligible), or with a probe already in flight.
 * Never-failed higher-ranked models (newly ranked or promoted) are tried first
 * so they are not permanently hidden behind LKGP.
 */
export function buildAutoAttemptOrder(rankedModels, health = {}, lkgp = null, now = Date.now(), probeInFlight = new Set()) {
  if (!Array.isArray(rankedModels) || rankedModels.length === 0) return [];
  let start = 0;
  if (lkgp) {
    const idx = rankedModels.indexOf(lkgp);
    if (idx >= 0) start = idx;
  }
  const out = [];
  // Promotion lane: healthy higher-ranked models that never failed.
  for (let i = 0; i < start; i++) {
    if (isMainPathEligible(rankedModels[i], health, now, probeInFlight)) out.push(rankedModels[i]);
  }
  for (let i = start; i < rankedModels.length; i++) {
    if (isMainPathEligible(rankedModels[i], health, now, probeInFlight)) out.push(rankedModels[i]);
  }
  return out;
}

/**
 * Select the single lightweight recovery probe for the whole auto/smart pool:
 * the highest-ranked failed model whose cooldown has expired, scanned across
 * the entire ranking. Selection is pool-scoped — if ANY probe is already in
 * flight (for any model, auto or smart) it returns null, so at most one probe
 * runs pool-wide. Per-model cooldown/health state still gates eligibility.
 */
export function selectProbeCandidate(rankedModels, health = {}, lkgp = null, now = Date.now(), probeInFlight = new Set()) {
  if (!Array.isArray(rankedModels) || rankedModels.length === 0) return null;
  // Pool-scoped single-probe lock.
  if (probeInFlight && typeof probeInFlight.size === "number" && probeInFlight.size > 0) return null;
  for (const model of rankedModels) {
    if (probeInFlight && typeof probeInFlight.has === "function" && probeInFlight.has(model)) {
      continue;
    }
    const entry = health?.[model];
    if (!entry || (Number(entry.failures) || 0) === 0) continue;
    const until = Number(entry.cooldownUntil) || 0;
    if (until <= now) return model;
  }
  return null;
}

/**
 * Rank-aware LKGP promotion. A candidate may replace the current LKGP only if
 * it is ranked strictly higher; equal, lower, unranked, or unknown candidates
 * keep the incumbent. Pure so the repo can run it inside a DB transaction.
 */
export function shouldPromoteLkgp(ranks, candidate, current) {
  if (typeof candidate !== "string" || !candidate.includes("/")) return false;
  if (!current) return true;
  if (candidate === current) return false;
  const cr = rankOf(candidate, ranks);
  const cur = rankOf(current, ranks);
  if (cr === null) return false;
  if (cur === null) return true;
  return cr > cur;
}

/**
 * Build a minimal, source-format-compatible recovery probe body.
 * Never resends the user prompt/tools/system: emits a single tiny "ping" and a
 * minimal token budget so a probe cannot leak sensitive context or cost much.
 * The conversation key/shape of the original request is preserved so the
 * translator pipeline still detects the same source format (openai/claude/
 * openai-responses/gemini/antigravity).
 */
export function buildAutoProbeBody(body = {}) {
  const src = body && typeof body === "object" ? body : {};
  const out = { stream: false };

  if (Array.isArray(src.contents)) {
    // Gemini
    out.contents = [{ role: "user", parts: [{ text: "ping" }] }];
    out.generationConfig = { maxOutputTokens: 1 };
    return out;
  }

  if (src.request && Array.isArray(src.request.contents)) {
    // Antigravity (Gemini wrapped in request), userAgent drives detection
    out.request = {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    };
    if (typeof src.userAgent === "string") out.userAgent = src.userAgent;
    return out;
  }

  if (Array.isArray(src.input) || typeof src.input === "string") {
    // OpenAI Responses API
    out.input = Array.isArray(src.input)
      ? [{ role: "user", content: [{ type: "input_text", text: "ping" }] }]
      : "ping";
    out.max_output_tokens = 1;
    return out;
  }

  const firstContent = Array.isArray(src.messages)
    ? src.messages.find((m) => m && m.content !== undefined)?.content
    : undefined;

  if (Array.isArray(firstContent)) {
    // Claude: content is an array of typed blocks
    out.messages = [{ role: "user", content: [{ type: "text", text: "ping" }] }];
    out.max_tokens = 1;
    return out;
  }

  // OpenAI / default
  out.messages = [{ role: "user", content: "ping" }];
  out.max_tokens = 1;
  return out;
}

/**
 * Validate and normalize a ranks payload. All-or-nothing: any malformed model
 * key or rank value rejects the whole payload so the existing map is preserved
 * instead of being silently replaced with a partial one.
 * Returns { ok: true, ranks } or { ok: false, error }.
 */
export function parseRanksPayload(body) {
  const raw = body && typeof body === "object" ? body : null;
  const input = raw && raw.ranks && typeof raw.ranks === "object" && !Array.isArray(raw.ranks)
    ? raw.ranks
    : raw;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Provide { ranks: { 'provider/model': rank } }" };
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = typeof k === "string" ? k.trim() : "";
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) {
      return { ok: false, error: `Invalid model key: ${k}` };
    }
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    if (!provider || !model || /\s/.test(provider) || /\s/.test(model)) {
      return { ok: false, error: `Invalid model key: ${k}` };
    }
    let n;
    if (typeof v === "number") n = v;
    else if (typeof v === "string" && v.trim() !== "") n = Number(v);
    else return { ok: false, error: `Invalid rank for ${k}` };
    if (!Number.isFinite(n)) return { ok: false, error: `Invalid rank for ${k}` };
    out[key] = n;
  }
  return { ok: true, ranks: out };
}

/**
 * Build the dynamic auto/smart pool: only ranked + enabled + not disabled,
 * ordered highest rank first (higher number = smarter).
 * Registered models are included automatically once a ranking is assigned.
 */
export function collectRankedAutoModels(availableModels, ranks = {}, disabled = new Set()) {
  if (!Array.isArray(availableModels) || availableModels.length === 0) return [];
  const blocked = disabled instanceof Set ? disabled : new Set(disabled || []);
  const filtered = availableModels.filter((m) => {
    if (blocked.has(m)) return false;
    return rankOf(m, ranks) !== null;
  });
  return orderByRank(filtered, ranks);
}
