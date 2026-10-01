import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// /v1/models must advertise the live Kilo gateway catalog (not just the 8
// static registry entries) so clients and the score-rank list see the same
// dynamic models that actually route via passthrough.
const prevDataDir = process.env.DATA_DIR;
let tmpDir;
let dbx;
let route;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v1-models-kilo-test-"));
  process.env.DATA_DIR = tmpDir;
  dbx = await import("@/lib/db/index.js");
  route = await import("../../src/app/api/v1/models/route.js");
  await dbx.createProviderConnection({
    provider: "kilocode",
    authType: "oauth",
    name: "kilo",
    accessToken: "tok",
    providerSpecificData: {},
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows file-lock flake on scratch cleanup; ignore (pre-existing).
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/models kilocode live catalog", () => {
  it("advertises live gateway models under kc/ alongside the static entries", async () => {
    const kilo = await import("../../open-sse/services/kilocodeModels.js");
    kilo.clearKilocodeCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "cohere/north-mini-code:free", name: "North Mini Code" },
          { id: "openai/text-embedding-3-large", name: "Embed" },
        ],
      }),
    })));

    const models = await route.buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("kc/cohere/north-mini-code:free");
    expect(ids).toContain("kc/anthropic/claude-sonnet-4-20250514");
    expect(ids).not.toContain("kc/openai/text-embedding-3-large");
  });
});
