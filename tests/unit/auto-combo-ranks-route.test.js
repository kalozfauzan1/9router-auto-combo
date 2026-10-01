import { describe, it, expect, vi, beforeEach } from "vitest";

// Guard tests for the dashboard-auth `/api/models/ranks` endpoint: the browser
// gets its candidate list from here (never the public, API-key-guarded
// `/api/v1/models`), and score writes stay all-or-nothing so a malformed or
// partial payload can never replace the saved map.
const mocks = vi.hoisted(() => ({
  getModelRanks: vi.fn(),
  setModelRanks: vi.fn(),
  getAvailableAutoModels: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getModelRanks: mocks.getModelRanks,
  setModelRanks: mocks.setModelRanks,
}));

vi.mock("@/sse/services/autoComboService.js", () => ({
  getAvailableAutoModels: mocks.getAvailableAutoModels,
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

const { GET, PUT } = await import("../../src/app/api/models/ranks/route.js");

beforeEach(() => {
  vi.clearAllMocks();
});

function put(body) {
  return PUT(
    new Request("http://localhost/api/models/ranks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("GET /api/models/ranks candidate list", () => {
  it("returns the guarded candidate list plus saved ranks", async () => {
    mocks.getModelRanks.mockResolvedValue({ "p/a": 5 });
    mocks.getAvailableAutoModels.mockResolvedValue(["p/a", "p/b"]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ranks: { "p/a": 5 }, models: ["p/a", "p/b"] });
  });

  it("fails with an explicit non-2xx when eligibility lookup fails (never a false empty list)", async () => {
    mocks.getModelRanks.mockResolvedValue({ "p/a": 5 });
    mocks.getAvailableAutoModels.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.models).toBeUndefined();
  });

  it("fails with an explicit non-2xx when the ranks lookup fails", async () => {
    mocks.getModelRanks.mockRejectedValue(new Error("db down"));
    mocks.getAvailableAutoModels.mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("PUT /api/models/ranks score update semantics", () => {
  it("replaces the map with normalized numeric scores", async () => {
    mocks.setModelRanks.mockImplementation(async (r) => r);
    const res = await put({ ranks: { " p/a ": 3, "p/b": "7" } });
    expect(res.status).toBe(200);
    expect(mocks.setModelRanks).toHaveBeenCalledWith({ "p/a": 3, "p/b": 7 });
    expect(await res.json()).toEqual({ ranks: { "p/a": 3, "p/b": 7 } });
  });

  it("persists a reduced map when a score is cleared", async () => {
    mocks.setModelRanks.mockImplementation(async (r) => r);
    const res = await put({ ranks: { "p/a": 3 } });
    expect(res.status).toBe(200);
    expect(mocks.setModelRanks).toHaveBeenCalledWith({ "p/a": 3 });
  });

  it("rejects a partial/malformed map with 400 and never writes", async () => {
    const res = await put({ ranks: { "p/a": 3, "not-a-model": 1 } });
    expect(res.status).toBe(400);
    expect(mocks.setModelRanks).not.toHaveBeenCalled();
  });

  it("rejects a non-finite score with 400 and never writes", async () => {
    const res = await put({ ranks: { "p/a": "abc" } });
    expect(res.status).toBe(400);
    expect(mocks.setModelRanks).not.toHaveBeenCalled();
  });
});
