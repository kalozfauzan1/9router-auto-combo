// Relay LKGP / health hooks inside the auth service.
//
// The relay-health bookkeeping is strictly advisory: a relay-health write must
// NEVER change the HTTP outcome of a request. These tests pin the wiring of
// markAccountUnavailable (failure path) and clearAccountError (success path)
// and the fail-open guarantee around both.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  getRelayLkgp: vi.fn(),
  getRelayHealthForModel: vi.fn(),
  getRelayHealth: vi.fn(),
  bumpRelayFailure: vi.fn(),
  noteRelayIdentityFail: vi.fn(),
  resetRelayHealth: vi.fn(),
  setRelayLkgp: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  recordOpencodeRelayFailure: vi.fn(),
  clearOpencodeRelayWarning: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
  getRelayLkgp: mocks.getRelayLkgp,
  getRelayHealthForModel: mocks.getRelayHealthForModel,
  getRelayHealth: mocks.getRelayHealth,
  bumpRelayFailure: mocks.bumpRelayFailure,
  noteRelayIdentityFail: mocks.noteRelayIdentityFail,
  resetRelayHealth: mocks.resetRelayHealth,
  setRelayLkgp: mocks.setRelayLkgp,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));

vi.mock("@/lib/network/opencodeRelayDiagnostics.js", () => ({
  recordOpencodeRelayFailure: mocks.recordOpencodeRelayFailure,
  clearOpencodeRelayWarning: mocks.clearOpencodeRelayWarning,
}));

const { markAccountUnavailable, clearAccountError } = await import("@/sse/services/auth.js");

const IDENTITY_403 = "free tier can only be used from within OpenCode";
const IP_QUARANTINE_403 = "OpenCode detected abusive traffic from this IP address";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([]);
  mocks.updateProviderConnection.mockResolvedValue(undefined);
  mocks.getSettings.mockResolvedValue({
    providerStrategies: { opencode: { relayCooldown: {} } },
  });
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.validateApiKey.mockResolvedValue(true);
  mocks.getRelayLkgp.mockResolvedValue(null);
  mocks.getRelayHealthForModel.mockResolvedValue({});
  mocks.getRelayHealth.mockResolvedValue(null);
  mocks.bumpRelayFailure.mockResolvedValue(null);
  mocks.noteRelayIdentityFail.mockResolvedValue(null);
  mocks.resetRelayHealth.mockResolvedValue(null);
  mocks.setRelayLkgp.mockResolvedValue(null);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({ proxyPoolId: null, proxyPool: null });
  mocks.pickProxyPoolId.mockImplementation((poolIds) => poolIds?.[0] || null);
  mocks.recordOpencodeRelayFailure.mockResolvedValue(null);
  mocks.clearOpencodeRelayWarning.mockResolvedValue(null);
});

describe("markAccountUnavailable — relay health hooks", () => {
  it("treats an identity reject as a relay switch without any relay penalty", async () => {
    const result = await markAccountUnavailable("conn-1", 403, IDENTITY_403, "opencode", "m");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(mocks.noteRelayIdentityFail).toHaveBeenCalledTimes(1);
    expect(mocks.noteRelayIdentityFail).toHaveBeenCalledWith("conn-1", "m");
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(mocks.bumpRelayFailure).not.toHaveBeenCalled();
  });

  it("does not punish a relay for an identity reject on a proxy pool either", async () => {
    const result = await markAccountUnavailable("proxy:abc", 403, IDENTITY_403, "opencode", "m");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(mocks.noteRelayIdentityFail).toHaveBeenCalledWith("proxy:abc", "m");
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(mocks.bumpRelayFailure).not.toHaveBeenCalled();
  });

  it("records an ip-quarantine failure with a 24-36 minute relay cooldown", async () => {
    const result = await markAccountUnavailable("proxy:abc", 403, IP_QUARANTINE_403, "opencode", "m");

    expect(result.shouldFallback).toBe(true);
    expect(mocks.bumpRelayFailure).toHaveBeenCalledTimes(1);

    const [connectionId, model, options] = mocks.bumpRelayFailure.mock.calls[0];
    expect(connectionId).toBe("proxy:abc");
    expect(model).toBe("m");
    expect(options.errorClass).toBe("ip-quarantine");
    expect(options.cooldownMs).toBeGreaterThanOrEqual(24 * 60 * 1000);
    expect(options.cooldownMs).toBeLessThanOrEqual(36 * 60 * 1000);
  });

  it("records a transient failure with a 24-36 second relay cooldown", async () => {
    const result = await markAccountUnavailable("proxy:abc", 500, "upstream exploded", "opencode", "m");

    expect(result.shouldFallback).toBe(true);
    expect(mocks.bumpRelayFailure).toHaveBeenCalledTimes(1);

    const [, model, options] = mocks.bumpRelayFailure.mock.calls[0];
    expect(model).toBe("m");
    expect(options.errorClass).toBe("transient");
    expect(options.cooldownMs).toBeGreaterThanOrEqual(24_000);
    expect(options.cooldownMs).toBeLessThanOrEqual(36_000);
  });

  it("records the relay health of a normal (non-proxy) connection after the lock write", async () => {
    const result = await markAccountUnavailable("conn-1", 500, "upstream exploded", "opencode", "m");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 30_000 });
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(mocks.bumpRelayFailure).toHaveBeenCalledTimes(1);

    const [connectionId, model, options] = mocks.bumpRelayFailure.mock.calls[0];
    expect(connectionId).toBe("conn-1");
    expect(model).toBe("m");
    expect(options.errorClass).toBe("transient");
    expect(options.cooldownMs).toBeGreaterThanOrEqual(24_000);
    expect(options.cooldownMs).toBeLessThanOrEqual(36_000);
  });

  it("never records relay health for a request-scoped 400", async () => {
    const result = await markAccountUnavailable("proxy:abc", 400, "invalid parameter", "opencode", "m");

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.bumpRelayFailure).not.toHaveBeenCalled();
    expect(mocks.noteRelayIdentityFail).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps the returned result unchanged when the relay repo write fails", async () => {
    mocks.bumpRelayFailure.mockRejectedValueOnce(new Error("relay store unavailable"));

    const result = await markAccountUnavailable("proxy:abc", 500, "upstream exploded", "opencode", "m");

    expect(result).toEqual({ shouldFallback: true, cooldownMs: 30_000 });
  });
});

describe("clearAccountError — relay LKGP hooks", () => {
  it("promotes a proxy pool to last-known-good and clears its relay health", async () => {
    await clearAccountError("proxy:abc", { _connection: {} }, "m", "opencode");

    expect(mocks.setRelayLkgp).toHaveBeenCalledTimes(1);
    expect(mocks.setRelayLkgp).toHaveBeenCalledWith("opencode", "m", "proxy:abc");
    expect(mocks.resetRelayHealth).toHaveBeenCalledTimes(1);
    expect(mocks.resetRelayHealth).toHaveBeenCalledWith("proxy:abc", "m");
  });

  it("promotes a normal connection to last-known-good and clears its relay health", async () => {
    await clearAccountError("conn-1", { _connection: {} }, "m", "opencode");

    expect(mocks.setRelayLkgp).toHaveBeenCalledTimes(1);
    expect(mocks.setRelayLkgp).toHaveBeenCalledWith("opencode", "m", "conn-1");
    expect(mocks.resetRelayHealth).toHaveBeenCalledTimes(1);
    expect(mocks.resetRelayHealth).toHaveBeenCalledWith("conn-1", "m");
  });

  it("does not touch the relay health when no provider is known", async () => {
    await clearAccountError("conn-1", { _connection: {} }, "m", null);

    expect(mocks.setRelayLkgp).not.toHaveBeenCalled();
    expect(mocks.resetRelayHealth).not.toHaveBeenCalled();
  });

  it("keeps the success path intact when the relay repo write fails", async () => {
    mocks.setRelayLkgp.mockRejectedValueOnce(new Error("relay store unavailable"));

    await expect(
      clearAccountError("conn-1", { _connection: {} }, "m", "opencode"),
    ).resolves.toBeUndefined();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
