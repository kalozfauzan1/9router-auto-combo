import { OPENCODE_FREE_LANE_CONFIG } from "../config/runtimeConfig.js";

function isNonEmptyString(value) {
  return !!value && String(value).trim() !== "";
}

export function isRelayEgress(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return isNonEmptyString(entry.vercelRelayUrl);
}

function normalizeConnectAlternate(entry) {
  return {
    proxyPoolId: entry.proxyPoolId ?? null,
    connectionProxyEnabled: true,
    connectionProxyUrl: entry.connectionProxyUrl ?? entry.url ?? "",
    connectionNoProxy: entry.connectionNoProxy ?? "",
    vercelRelayUrl: "",
    strictProxy: entry.strictProxy ?? false,
  };
}

export function resolveOpencodeFreeLane(provider, proxyOptions, mode = OPENCODE_FREE_LANE_CONFIG.mode) {
  if (provider !== "opencode") {
    return { applied: false, mode, reason: "not-opencode", proxyOptions };
  }
  if (!proxyOptions) {
    return { applied: false, mode, reason: "no-egress", proxyOptions };
  }
  if (mode === "off") {
    return { applied: false, mode, reason: "disabled", proxyOptions };
  }

  const relayPrimary = isNonEmptyString(proxyOptions.vercelRelayUrl);
  const connectPrimary =
    proxyOptions.connectionProxyEnabled === true && isNonEmptyString(proxyOptions.connectionProxyUrl);
  const poolPrimary = proxyOptions.proxyPoolId != null;

  const alternates = Array.isArray(proxyOptions.connectionProxyAlternates)
    ? proxyOptions.connectionProxyAlternates.map((entry) => (entry == null ? null : { ...entry }))
    : [];

  const relayAlternates = alternates.filter(isRelayEgress);
  const connectAlternates = alternates.filter(
    (entry) => entry && !isRelayEgress(entry) && isNonEmptyString(entry.connectionProxyUrl || entry.url)
  );

  if (!relayPrimary && !connectPrimary && !poolPrimary && relayAlternates.length === 0 && connectAlternates.length === 0) {
    return { applied: false, mode, reason: "no-egress", proxyOptions };
  }

  if (mode === "direct") {
    const next = {
      ...proxyOptions,
      vercelRelayUrl: "",
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      connectionProxyAlternates: [],
      proxyPoolId: null,
      strictProxy: false,
    };
    return { applied: true, mode, reason: "forced-direct", proxyOptions: next };
  }

  if (mode !== "proxy" && mode !== "auto") {
    return { applied: false, mode, reason: "kept", proxyOptions };
  }

  const hasRelay = relayPrimary || relayAlternates.length > 0;

  if (!hasRelay) {
    return { applied: false, mode, reason: "kept", proxyOptions };
  }

  let next = { ...proxyOptions };
  let reason;

  if (relayPrimary) {
    next = { ...next, vercelRelayUrl: "" };

    const normalizedAlternates = connectAlternates.map(normalizeConnectAlternate);

    if (!connectPrimary && connectAlternates.length > 0) {
      const promoted = normalizedAlternates[0];
      next = {
        ...next,
        connectionProxyEnabled: promoted.connectionProxyEnabled,
        connectionProxyUrl: promoted.connectionProxyUrl,
        connectionNoProxy: promoted.connectionNoProxy,
        proxyPoolId: promoted.proxyPoolId,
        strictProxy: promoted.strictProxy,
        connectionProxyAlternates: normalizedAlternates.slice(1),
      };
      reason = "relay-promoted";
    } else if (!connectPrimary && connectAlternates.length === 0 && !poolPrimary) {
      next = {
        ...next,
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        connectionProxyAlternates: [],
        proxyPoolId: null,
        strictProxy: false,
      };
      reason = "relay-only";
    } else {
      next = { ...next, connectionProxyAlternates: normalizedAlternates };
      reason = "relay-stripped";
    }
  } else {
    const normalized = connectAlternates.map(normalizeConnectAlternate);
    next = { ...next, connectionProxyAlternates: normalized };
    reason = "alternates-filtered";
  }

  return { applied: true, mode, reason, proxyOptions: next };
}

export function resolveOpencodeFreeLaneMode(provider) {
  return provider === "opencode" ? OPENCODE_FREE_LANE_CONFIG.mode : null;
}

export function shouldBypassRelayPool(mode) {
  return mode === "direct" || mode === "auto";
}
