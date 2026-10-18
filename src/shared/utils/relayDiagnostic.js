// Shared OpenCode relay-diagnostic helpers (client + server safe: no DB/Node imports).
//
// The dashboard shows the latest OpenCode upstream relay failure per proxy pool.
// Failure classification and display text live here so the server recorder and
// the proxy-pools dashboard render the exact same labels.

export const OPENCODE_RELAY_DIAGNOSTIC_KEY = "opencodeRelayDiagnostic";

/** Stored detail is always truncated to this many characters. */
export const RELAY_DETAIL_MAX_LENGTH = 300;

/** Explicit abusive-traffic / abuse-detection signals from the upstream error body. */
const ABUSE_PATTERN = /abusive traffic|detect(?:ed)? abuse traffic|network[\s_-]?abuse|abuse detected/i;

/** App-identity rejection phrase (possessive before "free tier" allowed). */
const APP_ONLY_PATTERN = /(?:['’]s\s+)?free tier can only be used from within opencode/i;

/**
 * Strip credential-shaped material from a failure detail before it is stored.
 * Only plain strings are accepted; objects (which could carry headers) are
 * dropped entirely. Never throws.
 */
export function sanitizeRelayDetail(errorText, maxLength = RELAY_DETAIL_MAX_LENGTH) {
  if (typeof errorText !== "string") return "";
  let detail = errorText;

  // credentials embedded in URL query strings
  detail = detail.replace(
    /([?&])(api[_-]?key|access[_-]?token|auth|authorization|key|password|secret|sig|signature|token)=([^&\s"'`]+)/gi,
    "$1$2=[redacted]",
  );
  // credentials embedded in URL userinfo
  detail = detail.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
  // Authorization/Bearer header values
  detail = detail.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  // provider key shapes (sk-…, oc_sk_…, ghp_…, JWT …)
  detail = detail.replace(/\b(?:sk|oc_sk|ghp|github_pat|xai)-?[A-Za-z0-9_.-]{12,}/g, "[redacted]");
  detail = detail.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]");
  // JSON/header-style pairs such as "x-api-key":"…"
  detail = detail.replace(
    /("(?:api[_-]?key|authorization|x-api-key|token|secret)[^"]*"\s*:\s*")[^"]*(")/gi,
    "$1[redacted]$2",
  );

  return detail.length > maxLength ? detail.slice(0, maxLength) : detail;
}

/**
 * Classify an OpenCode upstream relay failure.
 * kinds:
 *  - "abuse"    explicit abusive-traffic / abuse-detection signal in the body
 *  - "app_only" explicit "free tier can only be used from within OpenCode" rejection
 *  - "auth"     401 upstream auth/access protection (takes priority)
 *  - "other"    anything else; a bare 403 is never labelled abuse
 */
export function classifyOpencodeRelayFailure(status, errorText) {
  const text = typeof errorText === "string" ? errorText : "";
  if (Number(status) === 401) return "auth";
  if (ABUSE_PATTERN.test(text)) return "abuse";
  if (APP_ONLY_PATTERN.test(text)) return "app_only";
  return "other";
}
