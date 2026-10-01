import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectRankedAutoModels } from "../../open-sse/services/autoCombo.js";

// DB modules are imported dynamically AFTER DATA_DIR points at a scratch dir,
// so these tests never touch the real ~/.9router database.
const prevDataDir = process.env.DATA_DIR;
let tmpDir;
let repo;
let dbx;
let svc;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-combo-test-"));
  process.env.DATA_DIR = tmpDir;
  repo = await import("../../src/lib/db/repos/autoComboRepo.js");
  dbx = await import("@/lib/db/index.js");
  svc = await import("../../src/sse/services/autoComboService.js");
  // Force adapter init inside the scratch dir.
  await repo.getModelRanks();
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows file-lock flake on scratch cleanup (DB handle still open); ignore.
  }
});

describe("auto/smart test DB isolation", () => {
  it("uses a scratch DATA_DIR, never the user database", () => {
    expect(process.env.DATA_DIR).toBe(tmpDir);
    expect(tmpDir.startsWith(os.tmpdir())).toBe(true);
    expect(tmpDir).not.toContain(".9router");
    expect(fs.existsSync(path.join(tmpDir, "db", "data.sqlite"))).toBe(true);
  });
});

describe("auto/smart ranked model collection", () => {
  it("includes only ranked, enabled models ordered highest rank first", () => {
    const available = ["a/m1", "b/m2", "c/m3", "d/m4"];
    const ranks = { "c/m3": 30, "a/m1": 10, "b/m2": 20 };
    const disabled = new Set(["b/m2"]);
    expect(collectRankedAutoModels(available, ranks, disabled)).toEqual(["c/m3", "a/m1"]);
  });
});

describe("auto/smart atomic failure tracking", () => {
  it("counts concurrent failure increments without collapsing", async () => {
    const model = "test-provider/concurrent-model";
    const nowMs = 1_700_000_000_000;
    await Promise.all(
      Array.from({ length: 20 }, () => repo.bumpAutoModelFailure(model, nowMs))
    );
    const health = await repo.getAutoHealth();
    expect(health[model].failures).toBe(20);
    // 20th consecutive failure pins at the 60m ladder cap.
    expect(health[model].cooldownUntil).toBe(nowMs + 3_600_000);
  });

  it("resets failure state without disturbing the failure count term", async () => {
    const model = "test-provider/reset-model";
    await repo.bumpAutoModelFailure(model, 1000);
    await repo.bumpAutoModelFailure(model, 2000);
    await repo.resetAutoModelFailure(model);
    const health = await repo.getAutoHealth();
    expect(health[model].failures).toBe(0);
    expect(health[model].cooldownUntil).toBe(0);
  });
});

describe("auto/smart registered-model coverage", () => {
  it("requires membership in registered sources; mistyped ranked IDs are excluded", async () => {
    await dbx.createProviderConnection({
      provider: "qcust",
      authType: "apikey",
      name: "t",
      apiKey: "x",
      providerSpecificData: { enabledModels: ["qcust/known"] },
    });
    await dbx.addCustomModel({ providerAlias: "deadprov", id: "m1", type: "llm" });
    await dbx.setModelAlias("ghost-alias", "nobody/nada");
    await repo.setModelRanks({
      "qcust/ghost-live": 9,
      "qcust/known": 5,
      "deadprov/m1": 99,
      "nobody/nada": 50,
    });
    // "qcust/ghost-live" is ranked and its provider is active, but it is not in
    // enabledModels/static/custom/alias membership, so it must not route.
    const ranked = await svc.getAutoRankedModels();
    expect(ranked).toEqual(["qcust/known"]);

    // A live-discovered catalog is an accepted membership source.
    const withLive = await svc.getAutoRankedModels({ liveModels: ["qcust/ghost-live"] });
    expect(withLive).toEqual(["qcust/ghost-live", "qcust/known"]);
  });
});

describe("auto/smart rank-aware LKGP promotion", () => {
  it("keeps the highest-ranked LKGP under concurrent promotion", async () => {
    await repo.setModelRanks({ "test-provider/high": 10, "test-provider/low": 1 });
    await repo.clearAutoLkgp();

    await Promise.all([
      repo.promoteAutoLkgp("test-provider/low"),
      repo.promoteAutoLkgp("test-provider/high"),
    ]);
    expect(await repo.getAutoLkgp()).toBe("test-provider/high");

    // A later lower-ranked success must not overwrite the higher LKGP.
    await repo.promoteAutoLkgp("test-provider/low");
    expect(await repo.getAutoLkgp()).toBe("test-provider/high");
  });

  it("promotes a higher model over an existing LKGP and ignores equal/lower", async () => {
    await repo.setModelRanks({ "test-provider/a": 5, "test-provider/b": 7 });
    await repo.clearAutoLkgp();
    await repo.promoteAutoLkgp("test-provider/a");
    expect(await repo.getAutoLkgp()).toBe("test-provider/a");
    await repo.promoteAutoLkgp("test-provider/b");
    expect(await repo.getAutoLkgp()).toBe("test-provider/b");
    await repo.promoteAutoLkgp("test-provider/a");
    expect(await repo.getAutoLkgp()).toBe("test-provider/b");
  });
});

describe("auto/smart candidate eligibility", () => {
  it("includes active no-auth free provider models without a stored connection", async () => {
    const candidates = await svc.getAvailableAutoModels();
    expect(candidates.some((m) => m.startsWith("oc/"))).toBe(true);
  });

  it("routes a scored eligible model but never routes unscored candidates", async () => {
    const candidates = await svc.getAvailableAutoModels();
    const freeModels = candidates.filter((m) => m.startsWith("oc/"));
    expect(freeModels.length).toBeGreaterThan(1);
    await repo.setModelRanks({ [freeModels[0]]: 7 });
    const ranked = await svc.getAutoRankedModels();
    expect(ranked).toContain(freeModels[0]);
    expect(ranked).not.toContain(freeModels[1]);
  });

  it("drops a candidate and its routing when the provider connection is deactivated", async () => {
    const conn = await dbx.createProviderConnection({
      provider: "deact-prov",
      authType: "apikey",
      name: "deact",
      apiKey: "k",
      providerSpecificData: { enabledModels: ["deact-prov/m1"] },
    });
    await repo.setModelRanks({ "deact-prov/m1": 3 });
    expect(await svc.getAutoRankedModels()).toContain("deact-prov/m1");

    await dbx.updateProviderConnection(conn.id, { isActive: false });
    const candidates = await svc.getAvailableAutoModels();
    expect(candidates).not.toContain("deact-prov/m1");
    expect(await svc.getAutoRankedModels()).not.toContain("deact-prov/m1");
  });
});

describe("auto/smart persistence separation", () => {
  it("stores ranking as model config separately from runtime health/LKGP", async () => {
    await repo.setModelRank("test-provider/test-model", 42);
    const ranks = await repo.getModelRanks();
    expect(ranks["test-provider/test-model"]).toBe(42);

    await repo.setAutoModelHealth("test-provider/test-model", { failures: 2, cooldownUntil: 123 });
    const health = await repo.getAutoHealth();
    expect(health["test-provider/test-model"].failures).toBe(2);

    await repo.setAutoLkgp("test-provider/test-model");
    expect(await repo.getAutoLkgp()).toBe("test-provider/test-model");

    // Ranking key and runtime keys live apart: health must not leak into ranks.
    const ranksAfter = await repo.getModelRanks();
    expect(ranksAfter["test-provider/test-model"]).toBe(42);
  });
});

describe("auto/smart kilo live catalog membership", () => {
  const liveCatalog = {
    data: [
      { id: "cohere/north-mini-code:free", name: "North Mini Code" },
      { id: "openai/text-embedding-3-large", name: "Embed" },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists live kilo models as score candidates under the connection alias", async () => {
    const kilo = await import("../../open-sse/services/kilocodeModels.js");
    kilo.clearKilocodeCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => liveCatalog })));

    await dbx.createProviderConnection({
      provider: "kilocode",
      authType: "oauth",
      name: "kilo",
      accessToken: "tok",
      providerSpecificData: {},
    });

    const candidates = await svc.getAvailableAutoModels();
    // Live-only model appears under the kc/ output alias …
    expect(candidates).toContain("kc/cohere/north-mini-code:free");
    // … non-chat catalog entries never enter the candidate list …
    expect(candidates).not.toContain("kc/openai/text-embedding-3-large");
    // … and the static fallback entries still list.
    expect(candidates).toContain("kc/anthropic/claude-sonnet-4-20250514");
  });

  it("falls back to the static list when the live catalog is unreachable", async () => {
    const kilo = await import("../../open-sse/services/kilocodeModels.js");
    kilo.clearKilocodeCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));

    const candidates = await svc.getAvailableAutoModels();
    expect(candidates).toContain("kc/anthropic/claude-sonnet-4-20250514");
    expect(candidates).not.toContain("kc/cohere/north-mini-code:free");
  });
});
