import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep both KV scopes in RAM only; the SQLite kv layer is not under test here.
const { kvStores } = vi.hoisted(() => ({ kvStores: new Map() }));

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: (scope) => {
    if (!kvStores.has(scope)) kvStores.set(scope, new Map());
    const map = kvStores.get(scope);
    const clone = (value) => (value === undefined ? value : structuredClone(value));

    return {
      get: async (key, fallback = null) => (map.has(key) ? clone(map.get(key)) : fallback),
      set: async (key, value) => { map.set(key, clone(value)); },
      remove: async (key) => { map.delete(key); },
      getAll: async () => {
        const out = {};
        for (const [key, value] of map) out[key] = clone(value);
        return out;
      },
      clear: async () => { map.clear(); },
    };
  },
}));

const {
  getRelayLkgp,
  setRelayLkgp,
  clearRelayLkgp,
  getRelayHealth,
  getRelayHealthForModel,
  bumpRelayFailure,
  noteRelayIdentityFail,
  resetRelayHealth,
  clearAllRelayHealth,
  clearAllRelayLkgp,
  getAllRelayLkgp,
  getAllRelayHealth,
} = await import("@/lib/db/repos/relayLkgpRepo.js");

function store(scope) {
  if (!kvStores.has(scope)) kvStores.set(scope, new Map());
  return kvStores.get(scope);
}

beforeEach(() => {
  for (const map of kvStores.values()) map.clear();
});

describe("relayLkgpRepo", () => {
  it("composes keys with and without a model", async () => {
    const lkgp = await setRelayLkgp("openai", "gpt-5", "conn-a", 111);
    expect(lkgp).toEqual({ connectionId: "conn-a", updatedAt: 111, hits: 1 });
    expect(store("relayLkgp").get("openai:gpt-5")).toEqual(lkgp);
    expect(await getRelayLkgp("openai", "gpt-5")).toEqual(lkgp);

    const wildcard = await setRelayLkgp("openai", null, "conn-b", 222);
    expect(wildcard).toEqual({ connectionId: "conn-b", updatedAt: 222, hits: 1 });
    expect(store("relayLkgp").get("openai:*")).toEqual(wildcard);
    expect(await getRelayLkgp("openai")).toEqual(wildcard);

    const health = await resetRelayHealth("conn-a", "gpt-5", 333);
    expect(store("relayHealth").get("conn-a:gpt-5")).toEqual(health);
    expect(await getRelayHealth("conn-a", "gpt-5")).toEqual(health);

    const wildcardHealth = await resetRelayHealth("conn-b", undefined, 444);
    expect(store("relayHealth").get("conn-b:*")).toEqual(wildcardHealth);
    expect(await getRelayHealth("conn-b")).toEqual(wildcardHealth);
  });

  it("increments hits for the same connection and resets when it changes", async () => {
    expect((await setRelayLkgp("p", "m", "conn-a", 100)).hits).toBe(1);

    const second = await setRelayLkgp("p", "m", "conn-a", 200);
    expect(second).toEqual({ connectionId: "conn-a", updatedAt: 200, hits: 2 });

    const third = await setRelayLkgp("p", "m", "conn-a", 300);
    expect(third.hits).toBe(3);
    expect(third.updatedAt).toBe(300);

    const changed = await setRelayLkgp("p", "m", "conn-b", 400);
    expect(changed).toEqual({ connectionId: "conn-b", updatedAt: 400, hits: 1 });
    expect(await getRelayLkgp("p", "m")).toEqual(changed);
  });

  it("clearRelayLkgp only deletes the matching connection", async () => {
    await setRelayLkgp("p", "m", "conn-a", 100);

    expect(await clearRelayLkgp("p", "m", "conn-b")).toBe(false);
    expect(await getRelayLkgp("p", "m")).not.toBeNull();

    expect(await clearRelayLkgp("p", "m", "conn-a")).toBe(true);
    expect(await getRelayLkgp("p", "m")).toBeNull();

    await setRelayLkgp("p", "m", "conn-b", 200);
    expect(await clearRelayLkgp("p", "m")).toBe(true);
    expect(await getRelayLkgp("p", "m")).toBeNull();
  });

  it("getRelayHealthForModel filters by model and optional connection ids", async () => {
    await resetRelayHealth("conn-a", "model-1", 100);
    await resetRelayHealth("conn-b", "model-1", 200);
    await resetRelayHealth("conn-a", "model-2", 300);
    await resetRelayHealth("conn-c", null, 400);

    const model1 = await getRelayHealthForModel("model-1");
    expect(Object.keys(model1).sort()).toEqual(["conn-a", "conn-b"]);
    expect(model1["conn-a"].lastSuccessAt).toBe(100);
    expect(model1["conn-b"].lastSuccessAt).toBe(200);

    const subset = await getRelayHealthForModel("model-1", ["conn-b", "missing"]);
    expect(Object.keys(subset)).toEqual(["conn-b"]);
    expect(subset["conn-b"].lastSuccessAt).toBe(200);

    expect(await getRelayHealthForModel("model-1", [])).toEqual({});

    const wildcard = await getRelayHealthForModel();
    expect(Object.keys(wildcard)).toEqual(["conn-c"]);
    expect(wildcard["conn-c"].lastSuccessAt).toBe(400);
  });

  it("bumpRelayFailure increases failStreak and sets cooldownUntil = now + cooldownMs", async () => {
    const first = await bumpRelayFailure("conn-a", "m", { errorClass: "transient", cooldownMs: 30_000, now: 1_000 });
    expect(first.failStreak).toBe(1);
    expect(first.cooldownUntil).toBe(31_000);
    expect(first.lastFailureAt).toBe(1_000);
    expect(first.errorClass).toBe("transient");

    const second = await bumpRelayFailure("conn-a", "m", { errorClass: "credential", cooldownMs: 5_000, now: 2_000 });
    expect(second.failStreak).toBe(2);
    expect(second.cooldownUntil).toBe(7_000);
    expect(second.lastFailureAt).toBe(2_000);
    expect(second.errorClass).toBe("credential");

    expect(await getRelayHealth("conn-a", "m")).toEqual(second);
  });

  it("identity failures never set a cooldown and never change failStreak", async () => {
    const bumped = await bumpRelayFailure("conn-a", "m", { errorClass: "credential", cooldownMs: 60_000, now: 1_000 });
    expect(bumped.failStreak).toBe(1);
    expect(bumped.cooldownUntil).toBe(61_000);

    const noted = await noteRelayIdentityFail("conn-a", "m", 2_000);
    expect(noted.failStreak).toBe(1);
    expect(noted.cooldownUntil).toBe(61_000);
    expect(noted.identityFail).toBe(1);
    expect(noted.lastFailureAt).toBe(2_000);

    const notedAgain = await noteRelayIdentityFail("conn-a", "m", 3_000);
    expect(notedAgain.failStreak).toBe(1);
    expect(notedAgain.cooldownUntil).toBe(61_000);
    expect(notedAgain.identityFail).toBe(2);
    expect(await getRelayHealth("conn-a", "m")).toEqual(notedAgain);

    const fresh = await noteRelayIdentityFail("conn-b", "m", 4_000);
    expect(fresh).toEqual({
      failStreak: 0,
      lastFailureAt: 4_000,
      lastSuccessAt: 0,
      cooldownUntil: 0,
      identityFail: 1,
      errorClass: null,
    });
  });

  it("bumpRelayFailure keeps a previously counted identity failure", async () => {
    await noteRelayIdentityFail("conn-a", "m", 1_000);
    const bumped = await bumpRelayFailure("conn-a", "m", { cooldownMs: 1_000, now: 2_000 });
    expect(bumped.identityFail).toBe(1);
    expect(bumped.failStreak).toBe(1);
  });

  it("resetRelayHealth zeroes streak, cooldown and identity counters", async () => {
    await bumpRelayFailure("conn-a", "m", { errorClass: "credential", cooldownMs: 60_000, now: 1_000 });
    await noteRelayIdentityFail("conn-a", "m", 1_500);

    const reset = await resetRelayHealth("conn-a", "m", 9_000);
    expect(reset).toEqual({
      failStreak: 0,
      lastFailureAt: 0,
      lastSuccessAt: 9_000,
      cooldownUntil: 0,
      identityFail: 0,
      errorClass: null,
    });
    expect(await getRelayHealth("conn-a", "m")).toEqual(reset);
  });

  it("clearAll helpers empty both scopes", async () => {
    await setRelayLkgp("p", "m", "conn-a", 100);
    await bumpRelayFailure("conn-a", "m", { cooldownMs: 1_000, now: 200 });

    await clearAllRelayHealth();
    await clearAllRelayLkgp();

    expect(store("relayHealth").size).toBe(0);
    expect(store("relayLkgp").size).toBe(0);
  });

  it("guards missing ids without throwing", async () => {
    await expect(getRelayLkgp(null, "m")).resolves.toBeNull();
    await expect(getRelayLkgp("", "m")).resolves.toBeNull();
    await expect(setRelayLkgp("p", "m", null)).resolves.toBeNull();
    await expect(setRelayLkgp(null, "m", "conn-a")).resolves.toBeNull();
    await expect(clearRelayLkgp(undefined, "m")).resolves.toBe(false);
    await expect(getRelayHealth(null, "m")).resolves.toBeNull();
    await expect(bumpRelayFailure("", "m")).resolves.toBeNull();
    await expect(noteRelayIdentityFail(null, "m")).resolves.toBeNull();
    await expect(resetRelayHealth(undefined, "m")).resolves.toBeNull();
  });

  it("getAllRelayLkgp returns every entry keyed by provider:model", async () => {
    await setRelayLkgp("opencode", "gpt-5", "proxy:a", 100);
    await setRelayLkgp("opencode", "claude-3", "proxy:b", 200);
    await setRelayLkgp("qoder", "gpt-5", "conn-c", 300);

    const all = await getAllRelayLkgp();
    expect(Object.keys(all).sort()).toEqual(["opencode:claude-3", "opencode:gpt-5", "qoder:gpt-5"]);
    expect(all["opencode:gpt-5"]).toEqual({ connectionId: "proxy:a", updatedAt: 100, hits: 1 });
    expect(all["opencode:claude-3"]).toEqual({ connectionId: "proxy:b", updatedAt: 200, hits: 1 });
    expect(all["qoder:gpt-5"]).toEqual({ connectionId: "conn-c", updatedAt: 300, hits: 1 });
  });

  it("getAllRelayLkgp returns an empty map for an empty store", async () => {
    expect(await getAllRelayLkgp()).toEqual({});
  });

  it("getAllRelayHealth returns every entry keyed by connection:model", async () => {
    await resetRelayHealth("proxy:a", "gpt-5", 100);
    await bumpRelayFailure("proxy:b", "gpt-5", { errorClass: "transient", cooldownMs: 30_000, now: 200 });
    await resetRelayHealth("conn-c", "claude-3", 300);

    const all = await getAllRelayHealth();
    expect(Object.keys(all).sort()).toEqual(["conn-c:claude-3", "proxy:a:gpt-5", "proxy:b:gpt-5"]);
    expect(all["proxy:a:gpt-5"].lastSuccessAt).toBe(100);
    expect(all["proxy:b:gpt-5"].cooldownUntil).toBe(30_200);
    expect(all["proxy:b:gpt-5"].errorClass).toBe("transient");
    expect(all["conn-c:claude-3"].failStreak).toBe(0);
  });

  it("getAllRelayHealth returns an empty map for an empty store", async () => {
    expect(await getAllRelayHealth()).toEqual({});
  });

  it("getAll maps stay separate per scope and are emptied by the clear helpers", async () => {
    await setRelayLkgp("opencode", "gpt-5", "proxy:a", 100);
    await resetRelayHealth("proxy:a", "gpt-5", 100);

    expect(Object.keys(await getAllRelayLkgp())).toEqual(["opencode:gpt-5"]);
    expect(Object.keys(await getAllRelayHealth())).toEqual(["proxy:a:gpt-5"]);

    await clearAllRelayHealth();
    await clearAllRelayLkgp();

    expect(await getAllRelayLkgp()).toEqual({});
    expect(await getAllRelayHealth()).toEqual({});
  });
});
