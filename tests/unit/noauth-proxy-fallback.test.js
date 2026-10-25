import { beforeEach, describe, expect, it, vi } from "vitest";
import { opencodeFamilyFormats } from "open-sse/providers/models/helpers.js";
import { FORMATS } from "open-sse/translator/formats.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
  proxyConfigFromPool: (pool) => ({
    proxyPoolId: pool.id,
    connectionProxyEnabled: true,
    connectionProxyUrl: pool.proxyUrl,
    connectionNoProxy: "",
    vercelRelayUrl: pool.vercelRelayUrl || "",
    strictProxy: pool.strictProxy === true,
  }),
}));

import { clearAccountError, getProviderCredentials, markAccountUnavailable } from "@/sse/services/auth.js";

describe("no-auth proxy fallback and OpenCode family formats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.validateApiKey.mockResolvedValue(true);
    mocks.updateProviderConnection.mockResolvedValue(undefined);
    mocks.getSettings.mockResolvedValue({
      providerStrategies: {
        opencode: { rotateStrategy: "none" },
      },
    });
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.pickProxyPoolId.mockImplementation((poolIds) => poolIds[0] || null);
    mocks.resolveConnectionProxyConfig.mockImplementation(async ({ proxyPoolId } = {}) => ({
      proxyPoolId: proxyPoolId || null,
      proxyPool: proxyPoolId ? { name: `Relay ${proxyPoolId}` } : null,
      connectionProxyEnabled: Boolean(proxyPoolId),
      connectionProxyUrl: proxyPoolId ? `http://${proxyPoolId}.proxy.test:8080` : "",
      connectionNoProxy: "localhost",
      vercelRelayUrl: proxyPoolId ? `https://${proxyPoolId}.relay.test/api` : "",
      strictProxy: Boolean(proxyPoolId),
    }));
  });

  it("matches deepseek-v4.1-flash-free and its effort variant", () => {
    const v41Free = opencodeFamilyFormats("deepseek-v4.1-flash-free");
    expect(v41Free).not.toBeNull();
    expect(v41Free.supportedFormats).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

    const v41FreeEffort = opencodeFamilyFormats("deepseek-v4.1-flash-free(high)");
    expect(v41FreeEffort).not.toBeNull();
    expect(v41FreeEffort.supportedFormats).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

    const v4Flash = opencodeFamilyFormats("deepseek-v4-flash");
    expect(v4Flash).not.toBeNull();
    expect(v4Flash.supportedFormats).toEqual([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);
  });

  it("returns a proxy-backed virtual connection and preserves relay and strict-proxy settings", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "none", proxyPoolId: "pool-a" } },
    });

    const credentials = await getProviderCredentials("opencode");

    expect(credentials).toMatchObject({
      id: "proxy:pool-a",
      connectionId: "proxy:pool-a",
      connectionName: "Relay pool-a",
      accessToken: "public",
      providerSpecificData: {
        connectionProxyPoolId: "pool-a",
        vercelRelayUrl: "https://pool-a.relay.test/api",
        strictProxy: true,
      },
    });
    expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-a" });
  });

  it("rotates to the next unexcluded pool after the first virtual pool fails", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
    });
    mocks.getProxyPools.mockResolvedValue([
      { id: "pool-a", proxyUrl: "http://pool-a.proxy.test" },
      { id: "pool-b", proxyUrl: "http://pool-b.proxy.test" },
    ]);

    const first = await getProviderCredentials("opencode");
    expect(first.connectionId).toBe("proxy:pool-a");
    expect((await markAccountUnavailable(first.connectionId, 403, "Forbidden", "opencode")).shouldFallback).toBe(true);

    const second = await getProviderCredentials("opencode", new Set([first.connectionId]));
    expect(second.connectionId).toBe("proxy:pool-b");
    expect(mocks.pickProxyPoolId).toHaveBeenLastCalledWith(["pool-b"], "round-robin", "opencode");
  });

  it.each([
    ["proxy-prefixed", "proxy:pool-a"],
    ["raw", "pool-a"],
  ])("excludes a %s pool ID while rotating", async (_label, excludedId) => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
    });
    mocks.getProxyPools.mockResolvedValue([
      { id: "pool-a", proxyUrl: "http://pool-a.proxy.test" },
      { id: "pool-b", proxyUrl: "http://pool-b.proxy.test" },
    ]);

    const credentials = await getProviderCredentials("opencode", new Set([excludedId]));

    expect(credentials.connectionId).toBe("proxy:pool-b");
    expect(mocks.pickProxyPoolId).toHaveBeenCalledWith(["pool-b"], "round-robin", "opencode");
  });

  it("returns null rather than leaking directly when all rotating pools are exhausted", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
    });
    mocks.getProxyPools.mockResolvedValue([
      { id: "pool-a", proxyUrl: "http://pool-a.proxy.test" },
      { id: "pool-b", proxyUrl: "http://pool-b.proxy.test" },
    ]);

    const credentials = await getProviderCredentials("opencode", new Set(["proxy:pool-a", "pool-b"]));

    expect(credentials).toBeNull();
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(mocks.pickProxyPoolId).not.toHaveBeenCalled();
  });

  it.each(["proxy:pool-a", "pool-a"])("returns null for an excluded fixed proxy pool (%s)", async (excludedId) => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "none", proxyPoolId: "pool-a" } },
    });

    const credentials = await getProviderCredentials("opencode", new Set([excludedId]));

    expect(credentials).toBeNull();
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  it("keeps direct no-auth credentials valid without proxy pools", async () => {
    // The no-rotation configuration is the documented direct/no-pool baseline.
    const credentials = await getProviderCredentials("opencode");

    expect(credentials).toMatchObject({ id: "noauth", connectionId: "noauth", connectionName: "Public" });
    expect(credentials.providerSpecificData).toMatchObject({
      connectionProxyPoolId: null,
      vercelRelayUrl: "",
      strictProxy: false,
    });
    expect(mocks.getProxyPools).not.toHaveBeenCalled();
  });

  it("documents the empty rotating-pool baseline as unavailable, never direct", async () => {
    // Rotating mode requires at least one configured pool; an empty pool is not
    // equivalent to the explicit direct/no-rotation baseline above.
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
    });

    const credentials = await getProviderCredentials("opencode");

    expect(credentials).toBeNull();
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500, 502, 503])("allows proxy virtual-connection fallback for HTTP %i without DB updates", async (status) => {
    const result = await markAccountUnavailable("proxy:pool-a", status, "upstream error", "opencode", "deepseek-v4.1-flash-free");

    expect(result.shouldFallback).toBe(true);
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not fallback or update the DB for a non-retryable 400 on a virtual pool", async () => {
    const result = await markAccountUnavailable("proxy:pool-a", 400, "invalid request", "opencode", "deepseek-v4.1-flash-free");

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not mark direct no-auth credentials unavailable", async () => {
    const result = await markAccountUnavailable("noauth", 403, "Forbidden", "opencode", "deepseek-v4.1-flash-free");

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not clear persistent DB state for a successful virtual-pool connection", async () => {
    await clearAccountError("proxy:pool-a", {
      connectionId: "proxy:pool-a",
      providerSpecificData: { connectionProxyPoolId: "pool-a" },
    });

    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
