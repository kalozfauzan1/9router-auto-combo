import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { createComboHealthService } from "../../src/sse/services/comboHealthService.js";
const store = () => { const data = new Map(); return { async get(k, d = null) { return structuredClone(data.get(k) ?? d); }, async set(k, v) { data.set(k, structuredClone(v)); } }; };
const ok = () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
const log = { info() {}, warn() {} };
function setup(models = ["p/a", "p/b"]) {
  const health = createComboHealthService({ store: store() });
  const call = (fn, extra = {}) => handleComboChat({ body: {}, models, comboName: "c", comboStrategy: "fallback", log, comboHealth: health, handleSingleModel: fn, ...extra });
  return { health, call };
}
describe("combo health integration", () => {
  it.each(["get", "set"])("storage %s failure does not discard usable output or duplicate requests", async (operation) => {
    const kv = store();
    kv[operation] = () => { throw Error("storage down"); };
    const health = createComboHealthService({ store: kv, log });
    const fn = vi.fn(ok);
    const response = await handleComboChat({ body: {}, models: ["p/a", "p/b"], comboName: "c", comboStrategy: "fallback", log, comboHealth: health, handleSingleModel: fn });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("failure bookkeeping storage errors do not repeat a failed provider", async () => {
    const kv = store(); kv.set = () => { throw Error("storage down"); };
    const health = createComboHealthService({ store: kv, log });
    const fn = vi.fn((b, m) => m === "p/a" ? Response.json({ error: "busy" }, { status: 503 }) : ok());
    const response = await handleComboChat({ body: {}, models: ["p/a", "p/b"], comboName: "c", comboStrategy: "fallback", log, comboHealth: health, handleSingleModel: fn });
    expect(response.status).toBe(200);
    expect(fn.mock.calls.map(c => c[1])).toEqual(["p/a", "p/b"]);
  });
  it("records fallback failure, skips it next request, and reaches virtual auto without recording it", async () => {
    const { health, call } = setup(["p/a", "auto"]);
    const fn = vi.fn((b, m) => m === "auto" ? ok() : Response.json({ error: "rate limited" }, { status: 429 }));
    await call(fn); await call(fn);
    expect(fn.mock.calls.map(c => c[1])).toEqual(["p/a", "auto", "auto"]);
    expect((await health.getHealth("c", ["auto"]))["auto"].failures).toBe(0);
  });
  it("capability reorder wins over a healthy pin and legacy pin", async () => {
    const { health, call } = setup(["openai/gpt-3.5-turbo", "openai/gpt-4o"]);
    await health.recordSuccess("c", "openai/gpt-3.5-turbo", await health.beginAttempt("c", "openai/gpt-3.5-turbo"));
    const fn = vi.fn(ok);
    await call(fn, { comboLkgp: "openai/gpt-3.5-turbo", body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] } });
    expect(fn.mock.calls[0][1]).toBe("openai/gpt-4o");
  });
  it("does not cooldown request-scoped errors", async () => {
    const { health, call } = setup();
    await call((b, m) => m === "p/a" ? Response.json({ error: { message: "unsupported parameter: foo" } }, { status: 400 }) : ok());
    expect((await health.getHealth("c", ["p/a"]))["p/a"]?.failures || 0).toBe(0);
  });
  it("all cooling fires recovery before returning 503 with earliest deadline", async () => {
    const { health, call } = setup();
    await health.recordFailure("c", "p/a", { retryAfter: 900 });
    await health.recordFailure("c", "p/b", { retryAfter: 600 });
    const recover = vi.spyOn(health, "recover"); const fn = vi.fn(ok);
    const response = await call(fn);
    expect(response.status).toBe(503); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(590);
    expect((await response.json()).retryAfter).toBeTruthy();
    expect(fn).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledOnce();
  });
  it("ignores injected health outside fallback and leaves disabled path alone", async () => {
    const { health, call } = setup(); await health.recordFailure("c", "p/a");
    const fn = vi.fn(ok); await call(fn, { comboStrategy: "round-robin" }); expect(fn.mock.calls[0][1]).toBe("p/a");
    fn.mockClear(); await call(fn, { comboHealth: null }); expect(fn.mock.calls[0][1]).toBe("p/a");
  });
  it("captures token before call; consumes header and body retry-after; empty is not success", async () => {
    const { health, call } = setup();
    const begin = vi.spyOn(health, "beginAttempt"); const success = vi.spyOn(health, "recordSuccess");
    await call((b, m) => { expect(begin).toHaveBeenCalled(); return m === "p/a" ? Response.json({ retryAfter: new Date(Date.now() + 900000).toISOString() }, { status: 429, headers: { "retry-after": "600" } }) : ok(); });
    expect((await health.getHealth("c", ["p/a"]))["p/a"].cooldownUntil).toBeGreaterThan(Date.now() + 890000);
    expect(success).toHaveBeenCalledWith("c", "p/b", expect.anything());
    const second = setup(); await second.call(() => Response.json({ choices: [{ message: { content: "" }, finish_reason: "incomplete" }] }));
    expect((await second.health.getHealth("c", ["p/a", "p/b"]))["p/b"].failures).toBe(1);
  });
  it("shared service accepts per-call probe executor with sanitized body and signal", async () => {
    let clock = 0;
    const health = createComboHealthService({ store: store(), now: () => clock });
    await health.recordFailure("c", "p/a"); clock = 300001;
    const execute = vi.fn(({ body, signal }) => { expect(body.stream).toBe(false); expect(JSON.stringify(body)).not.toContain("SECRET"); expect(signal).toBeInstanceOf(AbortSignal); return ok(); });
    expect((await health.recover("c", ["p/a"], { messages: [{ content: "SECRET" }] }, execute)).status).toBe("recovered");
  });
  // chat.js has Next/db/auth dependencies; assert both branch wiring without booting the app.
  it("wires both direct and nested paths to singleton health and abort-capable core", () => {
    const source = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");
    expect(source.match(/comboHealthDeps\(comboCfg, comboStrategy/g)).toHaveLength(3);
    expect(source).toContain("signal: request?.signal");
    const core = readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");
    expect(core).toContain("AbortSignal.any");
  });
});
