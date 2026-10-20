import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools, getRelayLkgp, getRelayHealthForModel, getRelayHealth, bumpRelayFailure, noteRelayIdentityFail, resetRelayHealth, setRelayLkgp } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { recordOpencodeRelayFailure, clearOpencodeRelayWarning } from "@/lib/network/opencodeRelayDiagnostics.js";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { chooseRelay } from "open-sse/services/relaySelection.js";
import { classifyRelayError, relayCooldownMs, applyJitter, nextFailStreak } from "open-sse/services/relayHealth.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

async function applyRelayLkgp({ providerId, model, candidateIds, pinId, now }) {
  try {
    const lkgp = await getRelayLkgp(providerId, model);
    const health = await getRelayHealthForModel(model, candidateIds);
    return chooseRelay({
      candidates: candidateIds.map(id => ({ id })),
      health,
      lkgpId: lkgp?.connectionId || null,
      pinId,
      now,
    });
  } catch (error) {
    log.debug("AUTH", `relay selection failed: ${error?.message || error}`);
    return { mode: "none", chosen: null, ordered: candidateIds.map(id => ({ id })) };
  }
}

/**
 * Per-provider relay cooldown overrides.
 * Fail-open: any storage/settings problem yields an empty config, so the
 * built-in relay cooldown defaults stay in charge.
 */
async function relayCooldownConfig(providerId) {
  try {
    const settings = await getSettings();
    return (settings.providerStrategies || {})[providerId]?.relayCooldown || {};
  } catch {
    return {};
  }
}

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools
          .filter(p => p.proxyUrl)
          .map(p => p.id)
          .filter(id => !excludeSet.has(`proxy:${id}`) && !excludeSet.has(id));
        if (poolIds.length === 0) {
          log.warn("AUTH", `${provider} | all proxy pools exhausted (${excludeSet.size} excluded)`);
          return null;
        }
        if (override.lkgpEnabled === true) {
          // Relay health/LKGP keys use the same `proxy:<poolId>` id that
          // markAccountUnavailable/clearAccountError receive.
          const stripRelay = (id) => String(id).replace(/^proxy:/, "");
          const relayResult = await applyRelayLkgp({
            providerId,
            model,
            candidateIds: poolIds.map(id => `proxy:${id}`),
            pinId: null,
            now: Date.now(),
          });
          if (relayResult.mode === "lkgp" || relayResult.mode === "probe") {
            pickedId = stripRelay(relayResult.chosen.id);
            log.info("AUTH", `${provider} | relay ${relayResult.mode} ${pickedId.slice(0, 8)}`);
          } else if (relayResult.mode === "healthy") {
            pickedId = pickProxyPoolId(relayResult.ordered.map(c => stripRelay(c.id)), strategy, providerId);
          } else {
            pickedId = pickProxyPoolId(poolIds, strategy, providerId);
          }
        } else {
          pickedId = pickProxyPoolId(poolIds, strategy, providerId);
        }
      } else if (pickedId && (excludeSet.has(`proxy:${pickedId}`) || excludeSet.has(pickedId))) {
        log.warn("AUTH", `${provider} | configured proxy pool ${pickedId} excluded`);
        return null;
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      const connectionId = pickedId ? `proxy:${pickedId}` : "noauth";
      const connectionName = pickedId ? (resolvedProxy.proxyPool?.name || `Proxy (${pickedId.slice(0, 8)})`) : "Public";
      return {
        id: connectionId,
        connectionId,
        connectionName,
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    const lkgpEnabled = providerOverride.lkgpEnabled === true;
    let connection;
    let connectionPool = availableConnections;

    if (lkgpEnabled) {
      const relayResult = await applyRelayLkgp({
        providerId,
        model,
        candidateIds: availableConnections.map(c => c.id),
        pinId: preferredConnectionId,
        now: Date.now(),
      });
      if (relayResult.mode === "pinned" || relayResult.mode === "lkgp" || relayResult.mode === "probe") {
        connection = availableConnections.find(c => c.id === relayResult.chosen.id);
        log.info("AUTH", `${provider} | relay ${relayResult.mode} ${relayResult.chosen.id.slice(0, 8)}`);
      } else if (relayResult.mode === "healthy") {
        connectionPool = relayResult.ordered
          .map(c => availableConnections.find(x => x.id === c.id))
          .filter(Boolean);
      }
    }

    // Pin to preferred connection if specified and available
    if (!connection && preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...connectionPool].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...connectionPool].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = connectionPool[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const providerId = resolveProviderId(provider);
  const errorClass = classifyRelayError(status, errorText);

  // Identity rejects are not the relay's fault: try another relay, punish none.
  if (errorClass === "identity") {
    try { await noteRelayIdentityFail(connectionId, model); } catch { /* health only */ }
    if (connectionId.startsWith("proxy:")) {
      // Advisory OpenCode relay diagnostic (fail-open, never affects the result).
      try {
        await recordOpencodeRelayFailure({ connectionId, status, errorText, provider, model });
      } catch { /* diagnostic only */ }
    }
    log.warn("AUTH", `${connectionId.slice(0,8)} | identity reject (no relay penalty) [${status}]`);
    return { shouldFallback: true, cooldownMs: 0 };
  }

  if (connectionId.startsWith("proxy:")) {
    const { shouldFallback, cooldownMs } = checkFallbackError(status, errorText, 0, provider);
    // Advisory OpenCode relay diagnostic (fail-open, never affects the result below).
    if (shouldFallback) {
      try {
        await recordOpencodeRelayFailure({ connectionId, status, errorText, provider, model });
      } catch { /* diagnostic only */ }
      // Relay health bookkeeping (fail-open, never affects the result below).
      try {
        const prev = await getRelayHealth(connectionId, model);
        const now = Date.now();
        const streak = nextFailStreak(prev?.failStreak, now, prev?.lastFailureAt);
        const cfg = await relayCooldownConfig(providerId);
        const relayCd = applyJitter(relayCooldownMs(errorClass, streak, cfg));
        await bumpRelayFailure(connectionId, model, { errorClass, cooldownMs: relayCd, now });
      } catch { /* health only */ }
    }
    return { shouldFallback, cooldownMs };
  }
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  // Relay health bookkeeping (fail-open, never affects the result below).
  if (shouldFallback) {
    try {
      const prev = await getRelayHealth(connectionId, model);
      const now = Date.now();
      const streak = nextFailStreak(prev?.failStreak, now, prev?.lastFailureAt);
      const cfg = await relayCooldownConfig(providerId);
      const relayCd = applyJitter(relayCooldownMs(errorClass, streak, cfg));
      await bumpRelayFailure(connectionId, model, { errorClass, cooldownMs: relayCd, now });
    } catch { /* health only */ }
  }

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 * @param {string|null} provider - provider that succeeded; required to clear OpenCode relay warnings
 */
export async function clearAccountError(connectionId, currentConnection, model = null, provider = null) {
  if (!connectionId || connectionId === "noauth") return;
  // A real success promotes the connection to last-known-good and clears its
  // relay health. Fail-open: health must not break the success path.
  if (provider && connectionId) {
    try {
      const providerId = resolveProviderId(provider);
      await setRelayLkgp(providerId, model, connectionId);
      await resetRelayHealth(connectionId, model);
    } catch { /* health must not break success path */ }
  }
  if (connectionId.startsWith("proxy:")) {
    // OpenCode relay warning: a real success through the same pool clears the
    // active warning but keeps the last incident. Fail-open, advisory only.
    try {
      await clearOpencodeRelayWarning({ connectionId, provider });
    } catch { /* diagnostic only */ }
  }
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
