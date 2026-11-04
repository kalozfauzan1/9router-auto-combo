import { describe, it, expect } from "vitest";
import { createComboHealthRepo } from "../../src/lib/db/repos/comboLkgpRepo.js";

export function memoryStore() {
  const data = new Map();
  return { data, async get(key, fallback = null) { return structuredClone(data.get(key) ?? fallback); },
    async set(key, value) { await Promise.resolve(); data.set(key, structuredClone(value)); } };
}

describe("persistent combo member health", () => {
  it("persists isolated tuple keys without changing auto or LKGP namespaces", async () => {
    const store = memoryStore();
    await store.set("auto:health", { untouched: true });
    const repo = createComboHealthRepo({ store });
    await repo.recordFailure("a:b", "p/m", { now: 10 });
    await repo.recordFailure("a", "b:p/m", { now: 20 });
    await repo.recordFailure("a:b", "p/n", { now: 30 });
    await repo.setPin("a:b", "p/n");
    const fresh = createComboHealthRepo({ store });
    expect((await fresh.getHealth("a:b", ["p/m", "p/n"]))["p/m"].cooldownUntil).toBe(300010);
    expect((await fresh.getHealth("a", ["b:p/m"]))["b:p/m"].failures).toBe(1);
    expect(await fresh.getPin("a:b")).toBe("p/n");
    expect(await fresh.getPin("a")).toBeNull();
    expect(await store.get("auto:health")).toEqual({ untouched: true });
  });
  it("serializes same-key updates even across repo instances and preserves other members", async () => {
    const store = memoryStore();
    const a = createComboHealthRepo({ store });
    const b = createComboHealthRepo({ store });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).recordFailure("c", "p/m", { now: i })));
    await a.recordFailure("c", "p/n", { now: 0, retryAfterMs: 600000 });
    const health = await b.getHealth("c", ["p/m", "p/n"]);
    expect(health["p/m"].failures).toBe(20);
    expect(health["p/n"].cooldownUntil).toBe(600000);
  });
  it("rejects stale success even when a newer failure has the same timestamp", async () => {
    const repo = createComboHealthRepo({ store: memoryStore() });
    const old = await repo.beginAttempt("c", "p/m");
    await repo.recordFailure("c", "p/m", { now: 1 });
    expect(await repo.recordSuccess("c", "p/m", old)).toBe(false);
    const current = await repo.beginAttempt("c", "p/m");
    expect(await repo.recordSuccess("c", "p/m", current)).toBe(true);
    expect((await repo.getHealth("c", ["p/m"]))["p/m"].failures).toBe(0);
    await repo.recordFailure("c", "p/m", { now: 1 });
    expect(await repo.recordSuccess("c", "p/m", current)).toBe(false);
  });
  it("accepts an earlier-priority promotion despite a generation bump from a later success", async () => {
    const store = memoryStore();
    const repo = createComboHealthRepo({ store });
    const order = ["p/high", "p/low"];
    const high = await repo.beginAttempt("c", "p/high");
    const low = await repo.beginAttempt("c", "p/low");
    expect(await repo.setPin("c", "p/low", low)).toBe(true);
    expect(await repo.setPin("c", "p/high", high, { members: order })).toBe(true);
    expect(await repo.getPin("c")).toBe("p/high");
    expect((await store.get("lkgp:c")).generation).toBe(2);
  });
  it("rejects a late lower-priority success while a higher-priority pin exists", async () => {
    const store = memoryStore();
    const repo = createComboHealthRepo({ store });
    const order = ["p/high", "p/low"];
    const low = await repo.beginAttempt("c", "p/low");
    const high = await repo.beginAttempt("c", "p/high");
    expect(await repo.setPin("c", "p/high", high, { members: order })).toBe(true);
    expect(await repo.setPin("c", "p/low", low, { members: order })).toBe(false);
    expect(await repo.getPin("c")).toBe("p/high");
    expect((await store.get("lkgp:c")).generation).toBe(1);
  });
  it("still rejects a plain stale success without member order", async () => {
    const store = memoryStore();
    const repo = createComboHealthRepo({ store });
    const high = await repo.beginAttempt("c", "p/high");
    const low = await repo.beginAttempt("c", "p/low");
    expect(await repo.setPin("c", "p/low", low)).toBe(true);
    expect(await repo.setPin("c", "p/high", high)).toBe(false);
    expect(await repo.getPin("c")).toBe("p/low");
  });
});
