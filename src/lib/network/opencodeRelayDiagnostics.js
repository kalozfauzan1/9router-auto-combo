// OpenCode relay diagnostics (server-side recorder/clearer).
//
// Tracks the latest OpenCode upstream failure observed through each proxy-pool
// relay (`proxy:<poolId>` virtual connection) inside the pool's existing JSON
// data column, independently from generic testStatus/lastError.
//
// Every function here is advisory and fail-open: storage problems return null
// and never throw into the request path. Recording must never change retries,
// exclusions, pool activation, or routing; the caller keeps its own decisions.
import { resolveProviderId } from "@/shared/constants/providers.js";
import {
  OPENCODE_RELAY_DIAGNOSTIC_KEY,
  classifyOpencodeRelayFailure,
  sanitizeRelayDetail,
} from "@/shared/utils/relayDiagnostic.js";

const PROXY_CONNECTION_PREFIX = "proxy:";

/** Actual connectionProxyPoolId from a virtual connection id (`proxy:<id>`). */
export function relayPoolIdFromConnectionId(connectionId) {
  if (typeof connectionId !== "string" || !connectionId.startsWith(PROXY_CONNECTION_PREFIX)) return null;
  const poolId = connectionId.slice(PROXY_CONNECTION_PREFIX.length).trim();
  return poolId || null;
}

function isOpencodeProvider(provider) {
  try {
    return resolveProviderId(provider || "") === "opencode";
  } catch {
    return false;
  }
}

async function loadDb() {
  // Dynamic import keeps this module free of a hard DB dependency; failures
  // (including a mocked/incomplete DB module) are caught by the callers.
  return import("@/lib/localDb");
}

/**
 * Persist the latest OpenCode relay failure for the given pool.
 * Only records for `proxy:<poolId>` OpenCode connections.
 * @returns {object|null} the stored diagnostic, or null when nothing was stored.
 */
export async function recordOpencodeRelayFailure({ connectionId, status, errorText, provider, model } = {}) {
  try {
    const poolId = relayPoolIdFromConnectionId(connectionId);
    if (!poolId || !isOpencodeProvider(provider)) return null;

    const db = await loadDb();
    if (typeof db.updateProxyPoolDataField !== "function") return null;

    const diagnostic = {
      active: true,
      kind: classifyOpencodeRelayFailure(status, errorText),
      status: Number.isFinite(Number(status)) ? Number(status) : null,
      model: typeof model === "string" && model.trim() ? model.trim().slice(0, 120) : null,
      detail: sanitizeRelayDetail(errorText),
      lastIncidentAt: new Date().toISOString(),
      lastRecoveredAt: null,
    };

    const updated = await db.updateProxyPoolDataField(poolId, OPENCODE_RELAY_DIAGNOSTIC_KEY, diagnostic);
    return updated ? diagnostic : null;
  } catch {
    return null;
  }
}

/**
 * Clear the active OpenCode relay warning for this exact pool after a
 * successful OpenCode request through it. Keeps the last incident timestamp
 * and sanitized detail; only `active`/`lastRecoveredAt` move.
 */
export async function clearOpencodeRelayWarning({ connectionId, provider } = {}) {
  try {
    const poolId = relayPoolIdFromConnectionId(connectionId);
    if (!poolId || !isOpencodeProvider(provider)) return null;

    const db = await loadDb();
    if (typeof db.getProxyPoolById !== "function" || typeof db.updateProxyPoolDataField !== "function") return null;

    const pool = await db.getProxyPoolById(poolId);
    const current = pool?.[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    if (!current || typeof current !== "object" || current.active !== true) return null;

    const cleared = {
      ...current,
      active: false,
      lastRecoveredAt: new Date().toISOString(),
    };
    const updated = await db.updateProxyPoolDataField(poolId, OPENCODE_RELAY_DIAGNOSTIC_KEY, cleared);
    return updated ? cleared : null;
  } catch {
    return null;
  }
}
