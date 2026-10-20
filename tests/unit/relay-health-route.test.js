// Guard tests for the dashboard-auth `/api/models/relay-health` endpoint.
//
// The endpoint exposes the relay LKGP map (keyed `<provider>:<model>`) and the
// per-connection relay health map (keyed `<connection>:<model>`) so the
// provider page can show the last-known-good relay and the relays currently in
// cooldown. Failures must surface as a JSON error, never as a thrown error.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllRelayLkgp: vi.fn(),
  getAllRelayHealth: vi.fn(),
  clearAllRelayHealth: vi.fn(),
  clearAllRelayLkgp: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getAllRelayLkgp: mocks.getAllRelayLkgp,
  getAllRelayHealth: mocks.getAllRelayHealth,
  clearAllRelayHealth: mocks.clearAllRelayHealth,
  clearAllRelayLkgp: mocks.clearAllRelayLkgp,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const { GET, DELETE } = await import("../../src/app/api/models/relay-health/route.js");

function get(query = "") {
  return GET(new Request(`http://localhost/api/models/relay-health${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAllRelayLkgp.mockResolvedValue({});
  mocks.getAllRelayHealth.mockResolvedValue({});
  mocks.clearAllRelayHealth.mockResolvedValue(undefined);
  mocks.clearAllRelayLkgp.mockResolvedValue(undefined);
});

describe("GET /api/models/relay-health", () => {
  it("returns the lkgp and health maps plus the current time", async () => {
    mocks.getAllRelayLkgp.mockResolvedValue({
      "opencode:gpt-5": { connectionId: "proxy:a", updatedAt: 100, hits: 2 },
    });
    mocks.getAllRelayHealth.mockResolvedValue({
      "proxy:a:gpt-5": { failStreak: 0, cooldownUntil: 0, identityFail: 0 },
    });

    const res = await get();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.lkgp).toEqual({
      "opencode:gpt-5": { connectionId: "proxy:a", updatedAt: 100, hits: 2 },
    });
    expect(body.health).toEqual({
      "proxy:a:gpt-5": { failStreak: 0, cooldownUntil: 0, identityFail: 0 },
    });
    expect(typeof body.now).toBe("number");
    expect(body.now).toBeGreaterThan(0);
  });

  it("filters both maps by model when ?model is given", async () => {
    mocks.getAllRelayLkgp.mockResolvedValue({
      "opencode:m": { connectionId: "proxy:a" },
      "opencode:other": { connectionId: "proxy:b" },
      "qoder:m": { connectionId: "proxy:c" },
    });
    mocks.getAllRelayHealth.mockResolvedValue({
      "proxy:a:m": { cooldownUntil: 0 },
      "proxy:b:other": { cooldownUntil: 0 },
      "proxy:c:m": { cooldownUntil: 0 },
    });

    const res = await get("?model=m");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body.lkgp).sort()).toEqual(["opencode:m", "qoder:m"]);
    expect(Object.keys(body.health).sort()).toEqual(["proxy:a:m", "proxy:c:m"]);
  });

  it("filters the lkgp map by provider when ?provider is given", async () => {
    mocks.getAllRelayLkgp.mockResolvedValue({
      "opencode:m": { connectionId: "proxy:a" },
      "opencode:other": { connectionId: "proxy:b" },
      "qoder:m": { connectionId: "proxy:c" },
    });
    mocks.getAllRelayHealth.mockResolvedValue({
      "proxy:a:m": { cooldownUntil: 0 },
    });

    const res = await get("?provider=opencode");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body.lkgp).sort()).toEqual(["opencode:m", "opencode:other"]);
    expect(Object.keys(body.health)).toEqual(["proxy:a:m"]);
  });

  it("applies the model and the provider filters together", async () => {
    mocks.getAllRelayLkgp.mockResolvedValue({
      "opencode:m": { connectionId: "proxy:a" },
      "opencode:other": { connectionId: "proxy:b" },
      "qoder:m": { connectionId: "proxy:c" },
    });
    mocks.getAllRelayHealth.mockResolvedValue({
      "proxy:a:m": { cooldownUntil: 0 },
      "proxy:b:other": { cooldownUntil: 0 },
    });

    const body = await (await get("?model=m&provider=opencode")).json();
    expect(Object.keys(body.lkgp)).toEqual(["opencode:m"]);
    expect(Object.keys(body.health)).toEqual(["proxy:a:m"]);
  });

  it("returns empty maps for an empty store", async () => {
    const body = await (await get()).json();
    expect(body.lkgp).toEqual({});
    expect(body.health).toEqual({});
  });

  it("returns a 500 JSON error when the repo rejects", async () => {
    mocks.getAllRelayLkgp.mockRejectedValue(new Error("db down"));
    mocks.getAllRelayHealth.mockResolvedValue({});

    const res = await get();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.lkgp).toBeUndefined();
  });
});

describe("DELETE /api/models/relay-health", () => {
  it("clears both scopes and returns ok", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.clearAllRelayHealth).toHaveBeenCalledTimes(1);
    expect(mocks.clearAllRelayLkgp).toHaveBeenCalledTimes(1);
  });

  it("returns a 500 JSON error when clearing fails", async () => {
    mocks.clearAllRelayHealth.mockRejectedValue(new Error("db down"));

    const res = await DELETE();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.ok).toBeUndefined();
  });
});
