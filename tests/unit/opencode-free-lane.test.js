import { describe, expect, it } from "vitest";

import { isRelayEgress, resolveOpencodeFreeLane, resolveOpencodeFreeLaneMode, shouldBypassRelayPool } from "../../open-sse/utils/opencodeFreeLane.js";
import { OPENCODE_FREE_LANE_CONFIG } from "../../open-sse/config/runtimeConfig.js";
import { resolveEffectiveProxyUrl } from "../../open-sse/utils/proxyResolution.js";

const baseProxy = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://proxy.example:8080",
  connectionNoProxy: "localhost",
  vercelRelayUrl: "https://relay.example",
  proxyPoolId: "pool-1",
  strictProxy: true,
  connectionProxyAlternates: [{ connectionProxyUrl: "http://alt.example:8080" }],
};

describe("resolveOpencodeFreeLane", () => {
  it("returns not-opencode for non-opencode providers", () => {
    const po = { ...baseProxy };
    const res = resolveOpencodeFreeLane("openai", po);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("not-opencode");
    expect(res.proxyOptions).toBe(po);
  });

  it("returns no-egress when proxyOptions is missing", () => {
    const res = resolveOpencodeFreeLane("opencode", null);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("no-egress");
    expect(res.proxyOptions).toBeNull();
  });

  it("returns disabled when mode is off", () => {
    const po = { ...baseProxy };
    const res = resolveOpencodeFreeLane("opencode", po, "off");
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("disabled");
    expect(res.proxyOptions).toBe(po);
  });

  it("direct mode clears relay, proxy, pool, and strictProxy", () => {
    const po = { ...baseProxy };
    const before = JSON.stringify(po);
    const res = resolveOpencodeFreeLane("opencode", po, "direct");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("forced-direct");
    expect(res.proxyOptions).not.toBe(po);
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(false);
    expect(res.proxyOptions.connectionProxyUrl).toBe("");
    expect(res.proxyOptions.connectionNoProxy).toBe("");
    expect(res.proxyOptions.connectionProxyAlternates).toEqual([]);
    expect(res.proxyOptions.proxyPoolId).toBeNull();
    expect(res.proxyOptions.strictProxy).toBe(false);
    expect(res.proxyOptions.freeLaneDirect).toBe(true);
    expect(JSON.stringify(po)).toBe(before);
  });

  it("proxy mode strips relay but keeps connect proxy", () => {
    const po = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: null,
      strictProxy: false,
      connectionProxyAlternates: [],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "proxy");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("relay-stripped");
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(true);
    expect(res.proxyOptions.connectionProxyUrl).toBe("http://proxy.example:8080");
    expect(res.proxyOptions.freeLaneDirect).toBe(false);
  });

  it("auto mode with relay-only becomes fully direct", () => {
    const po = {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: null,
      strictProxy: true,
      connectionProxyAlternates: ["x"],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "auto");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("relay-only");
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(false);
    expect(res.proxyOptions.connectionProxyUrl).toBe("");
    expect(res.proxyOptions.connectionNoProxy).toBe("");
    expect(res.proxyOptions.connectionProxyAlternates).toEqual([]);
    expect(res.proxyOptions.proxyPoolId).toBeNull();
    expect(res.proxyOptions.strictProxy).toBe(false);
    expect(res.proxyOptions.freeLaneDirect).toBe(true);
  });

  it("auto mode with relay primary + pool id + relay alternates clears everything", () => {
    const po = {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: "pool-1",
      strictProxy: true,
      connectionProxyAlternates: [
        { vercelRelayUrl: "https://relay-alt.example" },
      ],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "auto");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("relay-only");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(false);
    expect(res.proxyOptions.connectionProxyUrl).toBe("");
    expect(res.proxyOptions.proxyPoolId).toBeNull();
    expect(res.proxyOptions.strictProxy).toBe(false);
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyAlternates).toEqual([]);
    expect(res.proxyOptions.freeLaneDirect).toBe(true);
  });

  it("auto mode with relay+connect keeps connect and drops relay", () => {
    const po = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: null,
      strictProxy: false,
      connectionProxyAlternates: [],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "auto");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("relay-stripped");
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(true);
    expect(res.proxyOptions.connectionProxyUrl).toBe("http://proxy.example:8080");
  });

  it("auto mode with connect only stays untouched", () => {
    const po = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      proxyPoolId: null,
      strictProxy: false,
      connectionProxyAlternates: [],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "auto");
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("kept");
    expect(res.proxyOptions).toBe(po);
  });

  it("does not mutate the input object", () => {
    const po = { ...baseProxy };
    const snapshot = JSON.stringify(po);
    resolveOpencodeFreeLane("opencode", po, "direct");
    resolveOpencodeFreeLane("opencode", po, "proxy");
    resolveOpencodeFreeLane("opencode", po, "auto");
    expect(JSON.stringify(po)).toBe(snapshot);
  });

  it("direct clears alternates too", () => {
    const po = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: "pool-1",
      strictProxy: true,
      connectionProxyAlternates: [
        { connectionProxyUrl: "http://alt1.example:8080" },
        { connectionProxyUrl: "http://alt2.example:8080" },
      ],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "direct");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("forced-direct");
    expect(res.proxyOptions.connectionProxyAlternates).toEqual([]);
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
  });

  it("auto with relay primary + two connect alternates promotes first to primary", () => {
    const po = {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: null,
      strictProxy: false,
      connectionProxyAlternates: [
        { connectionProxyUrl: "http://alt1.example:8080", connectionNoProxy: "local1", strictProxy: true },
        { connectionProxyUrl: "http://alt2.example:8080", connectionNoProxy: "local2", strictProxy: false, proxyPoolId: "pool-alt" },
      ],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "auto");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("relay-promoted");
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(true);
    expect(res.proxyOptions.connectionProxyUrl).toBe("http://alt1.example:8080");
    expect(res.proxyOptions.connectionNoProxy).toBe("local1");
    expect(res.proxyOptions.proxyPoolId).toBeNull();
    expect(res.proxyOptions.strictProxy).toBe(true);
    expect(res.proxyOptions.connectionProxyAlternates).toHaveLength(1);
    expect(res.proxyOptions.connectionProxyAlternates[0].connectionProxyUrl).toBe("http://alt2.example:8080");
    expect(res.proxyOptions.connectionProxyAlternates[0].vercelRelayUrl).toBe("");
    expect(res.proxyOptions.freeLaneDirect).toBe(false);
  });

  it("auto with connect primary + relay alternate drops alternate and keeps primary", () => {
    const po = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      proxyPoolId: null,
      strictProxy: false,
      connectionProxyAlternates: [
        { vercelRelayUrl: "https://relay.example" },
      ],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "auto");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("alternates-filtered");
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(true);
    expect(res.proxyOptions.connectionProxyUrl).toBe("http://proxy.example:8080");
    expect(res.proxyOptions.connectionProxyAlternates).toEqual([]);
  });

  it("proxy with relay-only and no alternates clears everything", () => {
    const po = {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: null,
      strictProxy: true,
      connectionProxyAlternates: [],
    };
    const res = resolveOpencodeFreeLane("opencode", po, "proxy");
    expect(res.applied).toBe(true);
    expect(res.reason).toBe("relay-only");
    expect(res.proxyOptions.vercelRelayUrl).toBe("");
    expect(res.proxyOptions.connectionProxyEnabled).toBe(false);
    expect(res.proxyOptions.connectionProxyUrl).toBe("");
    expect(res.proxyOptions.connectionNoProxy).toBe("");
    expect(res.proxyOptions.connectionProxyAlternates).toEqual([]);
    expect(res.proxyOptions.proxyPoolId).toBeNull();
    expect(res.proxyOptions.strictProxy).toBe(false);
  });

  it("isRelayEgress returns true for relay entries", () => {
    expect(isRelayEgress({ vercelRelayUrl: "https://relay.example" })).toBe(true);
    expect(isRelayEgress({ vercelRelayUrl: "http://relay.example" })).toBe(true);
    expect(isRelayEgress({ vercelRelayUrl: "  " })).toBe(false);
  });

  it("isRelayEgress returns false for non-relay entries", () => {
    expect(isRelayEgress({ connectionProxyUrl: "http://proxy.example" })).toBe(false);
    expect(isRelayEgress({})).toBe(false);
    expect(isRelayEgress(null)).toBe(false);
    expect(isRelayEgress("string")).toBe(false);
  });

  it("does not mutate proxyOptions or the alternates array", () => {
    const po = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "https://relay.example",
      proxyPoolId: "pool-1",
      strictProxy: true,
      connectionProxyAlternates: [
        { connectionProxyUrl: "http://alt.example:8080", vercelRelayUrl: "https://relay-alt.example" },
      ],
    };
    const proxySnapshot = JSON.stringify(po);
    const alternatesSnapshot = JSON.stringify(po.connectionProxyAlternates);

    resolveOpencodeFreeLane("opencode", po, "auto");

    expect(JSON.stringify(po)).toBe(proxySnapshot);
    expect(JSON.stringify(po.connectionProxyAlternates)).toBe(alternatesSnapshot);
  });

  describe("resolveOpencodeFreeLaneMode", () => {
    it("returns mode for opencode provider", () => {
      expect(resolveOpencodeFreeLaneMode("opencode")).toBe(OPENCODE_FREE_LANE_CONFIG.mode);
    });

    it("returns null for non-opencode provider", () => {
      expect(resolveOpencodeFreeLaneMode("openai")).toBeNull();
    });
  });

  describe("shouldBypassRelayPool", () => {
    it("returns true for auto", () => {
      expect(shouldBypassRelayPool("auto")).toBe(true);
    });

    it("returns true for direct", () => {
      expect(shouldBypassRelayPool("direct")).toBe(true);
    });

    it("returns false for proxy", () => {
      expect(shouldBypassRelayPool("proxy")).toBe(false);
    });

    it("returns false for off", () => {
      expect(shouldBypassRelayPool("off")).toBe(false);
    });

    it("returns false for null", () => {
      expect(shouldBypassRelayPool(null)).toBe(false);
    });
  });

  describe("resolveEffectiveProxyUrl", () => {
    it("returns direct when freeLaneDirect is true even with HTTPS_PROXY set", () => {
      const original = process.env.HTTPS_PROXY;
      process.env.HTTPS_PROXY = "http://env-proxy.example:3128";

      try {
        const result = resolveEffectiveProxyUrl("https://example.com", { freeLaneDirect: true });
        expect(result).toEqual({ url: null, source: "direct" });
      } finally {
        if (original === undefined) {
          delete process.env.HTTPS_PROXY;
        } else {
          process.env.HTTPS_PROXY = original;
        }
      }
    });

    it("connection proxy still wins over env proxy", () => {
      const original = process.env.HTTPS_PROXY;
      process.env.HTTPS_PROXY = "http://env-proxy.example:3128";

      try {
        const result = resolveEffectiveProxyUrl("https://example.com", {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://conn.example:8080",
        });
        expect(result).toEqual({ url: "http://conn.example:8080", source: "connection" });
      } finally {
        if (original === undefined) {
          delete process.env.HTTPS_PROXY;
        } else {
          process.env.HTTPS_PROXY = original;
        }
      }
    });
  });
});
