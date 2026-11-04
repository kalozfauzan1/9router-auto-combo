import { afterEach, describe, expect, it, vi } from "vitest";
import { createComboHealthService } from "../../src/sse/services/comboHealthService.js";

const store = () => { const data = new Map(); return {
  async get(key, fallback = null) { return structuredClone(data.get(key) ?? fallback); },
  async set(key, value) { data.set(key, structuredClone(value)); },
}; };
const members = ["p/high", "p/low"];
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());

describe("combo health recovery", () => {
  async function failedService(executeProbe, options = {}) {
    const service = createComboHealthService({ store: store(), executeProbe, now: () => Date.now(), timeoutMs: 100, ...options });
    await service.recordFailure("c", members[0]);
    return service;
  }
  it("has one same-combo flight while independent combos run; restores manual priority over pin", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = deferred();
    const execute = vi.fn(() => gate.promise);
    const service = await failedService(execute);
    await service.recordFailure("other", members[0]);
    await service.recordSuccess("c", members[1], await service.beginAttempt("c", members[1]));
    await vi.advanceTimersByTimeAsync(300000);
    const first = service.recover("c", members, { messages: [{ role: "user", content: "SECRET" }], tools: [{ private: true }], metadata: "SECRET" });
    expect(await service.recover("c", members, {})).toEqual({ status: "busy" });
    const other = service.recover("other", members, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0].body).toEqual({ stream: false, messages: [{ role: "user", content: "ping" }], max_tokens: 16 });
    expect(execute.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    // Each execution must own its Response body.
    gate.resolve(null);
    expect((await first).status).toBe("failed");
    expect((await other).status).toBe("failed");
    await vi.advanceTimersByTimeAsync(300000);
    execute.mockImplementation(() => json({ choices: [{ message: { content: "ok" } }] }));
    expect(await service.recover("c", members, {})).toEqual({ status: "recovered", model: members[0] });
    expect(await service.getAttemptOrder("c", members)).toEqual(members);
  });
  it("bounds execution, aborts, releases lock, cancels late response and never promotes it", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const late = deferred(); const execute = vi.fn(() => late.promise);
    const service = await failedService(execute);
    await vi.advanceTimersByTimeAsync(300000);
    const pending = service.recover("c", members, {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "timeout", model: members[0] });
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
    expect(await service.recover("c", members, {})).toEqual({ status: "idle" });
    const cancel = vi.fn();
    late.resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await service.getAttemptOrder("c", members)).toEqual([members[1]]);
    await vi.advanceTimersByTimeAsync(300000);
    execute.mockImplementation(() => json({ choices: [{ message: { content: "new" } }] }));
    expect((await service.recover("c", members, {})).status).toBe("recovered");
  });
  it("bounds a hanging response body as well as executor resolution", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const cancel = vi.fn();
    const service = await failedService(() => new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(300000);
    const pending = service.recover("c", members, {});
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe("timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ choices: [{ message: { content: " " } }] }, "failed"],
    [{}, "failed"],
    [{ choices: [{ message: { tool_calls: [{ id: "t", type: "function", function: { name: "ok", arguments: "{}" } }] } }] }, "recovered"],
    [{ content: [{ type: "text", text: "ok" }] }, "recovered"],
    [{ content: [{ type: "tool_use", id: "t", name: "ok", input: {} }] }, "recovered"],
    [{ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }, "recovered"],
    [{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }, "recovered"],
  ])("requires usable text or tool payload: %j -> %s", async (payload, status) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const service = await failedService(() => json(payload));
    await vi.advanceTimersByTimeAsync(300000);
    expect((await service.recover("c", members, {})).status).toBe(status);
  });
  it("does not probe virtual/slashless or unexpired members", async () => {
    const execute = vi.fn(); const service = await failedService(execute, { now: () => 0 });
    expect(await service.recover("c", ["auto", "nested", ...members], {})).toEqual({ status: "idle" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("request-scoped probe errors do not poison state; retry-after applies to retryable failures", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const execute = vi.fn(() => json({ error: "bad request" }, 400));
    const service = await failedService(execute);
    await vi.advanceTimersByTimeAsync(300000);
    const before = await service.getHealth("c", members);
    expect((await service.recover("c", members, {})).status).toBe("request-scoped");
    expect(await service.getHealth("c", members)).toEqual(before);
    execute.mockImplementation(() => json({ error: "rate" }, 429, { "retry-after": "900" }));
    expect((await service.recover("c", members, {})).status).toBe("failed");
    expect((await service.getHealth("c", members))[members[0]].cooldownUntil).toBe(1200000);
    expect(await service.getAttemptOrder("other", members)).toEqual(members);
  });
  it("a newer main failure invalidates probe success", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = deferred(); const service = await failedService(() => gate.promise);
    await vi.advanceTimersByTimeAsync(300000);
    const pending = service.recover("c", members, {});
    await vi.advanceTimersByTimeAsync(0);
    await service.recordFailure("c", members[0]);
    gate.resolve(json({ choices: [{ message: { content: "ok" } }] }));
    expect((await pending).status).toBe("stale");
    expect(await service.getAttemptOrder("c", members)).toEqual([members[1]]);
  });
  it("promotes the earlier manual member when a later member success bumps the pin mid-probe", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const kv = store(); const gate = deferred();
    const service = createComboHealthService({ store: kv, now: () => Date.now(), timeoutMs: 100, executeProbe: () => gate.promise });
    await service.recordFailure("c", members[0]);
    await vi.advanceTimersByTimeAsync(300000);
    const pending = service.recover("c", members, {});
    await vi.advanceTimersByTimeAsync(0);
    // A lower-priority main success lands while the higher-priority probe is in flight.
    const lower = await service.beginAttempt("c", members[1]);
    expect(await service.recordSuccess("c", members[1], lower)).toBe(true);
    expect((await kv.get("lkgp:c")).model).toBe(members[1]);
    gate.resolve(json({ choices: [{ message: { content: "ok" } }] }));
    expect(await pending).toEqual({ status: "recovered", model: members[0] });
    expect((await kv.get("lkgp:c")).model).toBe(members[0]);
    expect(await service.getAttemptOrder("c", members)).toEqual(members);
  });
});

describe("combo health service main traffic", () => {
  it.each([401, 403])("cools down recovery authentication failure %s instead of hot probing", async (status) => {
    let clock = 0;
    const execute = vi.fn(() => json({ error: "auth" }, status));
    const service = createComboHealthService({ store: store(), now: () => clock, executeProbe: execute });
    await service.recordFailure("c", members[0]);
    clock = 300000;
    expect((await service.recover("c", members)).status).toBe("failed");
    for (let i = 0; i < 3; i++) expect((await service.recover("c", members)).status).toBe("idle");
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await service.getHealth("c", members))[members[0]].cooldownUntil).toBe(600000);
  });
  it("does not let an older lower-member success replace a newer recovery pin", async () => {
    let clock = 0;
    const kv = store();
    const service = createComboHealthService({ store: kv, now: () => clock, executeProbe: () => json({ choices: [{ message: { content: "ok" } }] }) });
    await service.recordFailure("c", members[0]);
    const older = await service.beginAttempt("c", members[1]);
    clock = 300000;
    expect((await service.recover("c", members)).status).toBe("recovered");
    await service.recordSuccess("c", members[1], older);
    expect((await kv.get("lkgp:c")).model).toBe(members[0]);
    expect((await service.getHealth("c", members))[members[1]].failures).toBe(0);
  });
  it("fails open on storage reads and even throwing diagnostic logging", async () => {
    const service = createComboHealthService({ store: { get() { throw Error("read down"); } }, log: { warn() { throw Error("logger down"); } } });
    expect(await service.beginAttempt("c", members[0])).toBeNull();
    expect(await service.getAttemptOrder("c", members)).toEqual(members);
    expect(await service.getHealth("c", members)).toEqual({});
  });
  it("persists health, skips failed members, supports Retry-After and stale guards", async () => {
    const kv = store();
    const service = createComboHealthService({ store: kv, now: () => 1000 });
    const attempt = await service.beginAttempt("c", members[0]);
    await service.recordFailure("c", members[0], { retryAfter: "600" });
    expect(await service.recordSuccess("c", members[0], attempt)).toBe(false);
    expect(await service.getAttemptOrder("c", members)).toEqual([members[1]]);
    const fresh = createComboHealthService({ store: kv, now: () => 1000 });
    expect((await fresh.getHealth("c", members))[members[0]].cooldownUntil).toBe(601000);
    const current = await fresh.beginAttempt("c", members[0]);
    expect(await fresh.recordSuccess("c", members[0], current)).toBe(true);
    expect(await fresh.getAttemptOrder("c", members)).toEqual(members);
  });
  it("ignores request-scoped and virtual failures and respects HTTP-date Retry-After", async () => {
    const service = createComboHealthService({ store: store(), now: () => 0 });
    await service.recordFailure("c", members[0], { requestScoped: true });
    await service.recordFailure("c", "auto");
    await service.recordFailure("c", "nested-combo");
    expect(await service.getAttemptOrder("c", [...members, "auto", "nested-combo"])).toEqual([...members, "auto", "nested-combo"]);
    await service.recordFailure("c", members[1], { retryAfter: new Date(900000).toUTCString() });
    expect((await service.getHealth("c", members))[members[1]].cooldownUntil).toBe(900000);
  });
});
