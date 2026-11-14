// The free lane sheds load with 429 "The inference service is overloaded.
// Please try again later." even after a request passes the TLS gate. The
// OpenCode CLI retries that transient 429; 9router used to surface it. These
// tests pin the custom executor contract: overload retries on the same
// session/egress up to eight attempts, without rotation or cooldown. A quota
// 429 instead gets one immediate retry on a rotated minted session; recovery
// reuses that session, while persistent quota returns the final body intact
// and cools the real egress. A 403 invalidates minted sessions for the next
// call only. Native client-supplied sessions never rotate.
//
// Egress resolution stays real. Only the probe *endpoint* is a deterministic
// loopback HTTP server: EGRESS_CONFIG.probeUrl points at it, so the real
// resolver confirms a direct egress and the real cooldown map is exercised.
// Nothing here reaches the public network.
import http from "node:http";
import { setImmediate as realSetImmediate } from "node:timers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the retry loop under test in isolation: no credentials, no upstream.
const { baseExecuteMock } = vi.hoisted(() => ({ baseExecuteMock: vi.fn() }));

vi.mock("../../open-sse/executors/base.js", () => ({
  BaseExecutor: class {
    async execute(args) {
      return baseExecuteMock(args);
    }
  },
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: vi.fn(),
}));

const {
  OpenCodeExecutor,
  forgetOpencodeSession,
  translateSessionId,
  OPENCODE_SESSION_RE,
} = await import("../../open-sse/executors/opencode.js");
const { EGRESS_CONFIG } = await import("../../open-sse/config/runtimeConfig.js");
const {
  resetEgressState,
  hasActiveDirectCooldown,
  getEgressCooldown,
} = await import("../../open-sse/utils/egress.js");

const MODEL = "deepseek-v4.1-flash-free";
const PROBE_IP = "127.0.0.1";
const CONFIRMED_DIRECT_ID = `direct:${PROBE_IP}`;

const OVERLOAD = JSON.stringify({
  error: {
    type: "server_error",
    message: "The inference service is overloaded. Please try again later.",
  },
});

// The other 429 on this route: the free-tier gate, which is not transient. It
// also says "try again later", so the classifier must key on "overloaded".
const FREE_USAGE = JSON.stringify({
  type: "error",
  error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Please try again later." },
});

const FREE_TIER = JSON.stringify({
  type: "error",
  error: { type: "FreeTierError", message: "free tier unavailable" },
});

// --- deterministic loopback egress probe ---------------------------------
// The probe is real I/O (node:http), so it must not race fake timers. Once the
// first upstream attempt is observed, the probe has already resolved; only then
// is it safe to advance the fake backoff timers.
let server;
let probeUrl;
let seq = 0;

const realSetImmediateRef = realSetImmediate;

async function waitForCallCount(target) {
  while (baseExecuteMock.mock.calls.length < target) {
    await new Promise((resolve) => realSetImmediateRef(resolve));
  }
}

const originalEgressConfig = { mode: EGRESS_CONFIG.mode, probeUrl: EGRESS_CONFIG.probeUrl };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ ip: PROBE_IP }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  probeUrl = `http://127.0.0.1:${server.address().port}/probe`;
});

afterAll(async () => {
  EGRESS_CONFIG.mode = originalEgressConfig.mode;
  EGRESS_CONFIG.probeUrl = originalEgressConfig.probeUrl;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  baseExecuteMock.mockReset();
  // Real reset, not a mock: cooldowns and the probe IP cache must not bleed
  // between tests or a "cooled" assertion could pass for the wrong reason.
  resetEgressState();
  EGRESS_CONFIG.probeUrl = probeUrl;
  // "always" keeps the real resolver/probe path active while still avoiding
  // the public network (the URL above is loopback). "off" would bypass egress
  // identity and make cooldown assertions meaningless.
  EGRESS_CONFIG.mode = "always";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCredentials() {
  return { rawHeaders: { authorization: `Bearer overload-test-${seq++}` } };
}

function makeBody(text = "say OK") {
  return {
    messages: [{ role: "user", content: text }],
  };
}

function upstream(status, body) {
  return {
    response: new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  };
}

const argsOf = (call) => call[0];
const sessionOf = (call) => argsOf(call).credentials._opencodeSession;
const bodyOf = (call) => argsOf(call).body;

async function run(executor, {
  log,
  credentials = {},
  body = makeBody(),
  signal,
  providerSessionId,
  clientTool,
  advanceMs = 0,
} = {}) {
  const callsBefore = baseExecuteMock.mock.calls.length;
  const pending = executor.execute({
    model: MODEL,
    body,
    stream: true,
    credentials,
    log,
    signal,
    providerSessionId,
    clientTool,
  });

  if (advanceMs > 0) {
    // The cold-cache probe must finish before fake timers can advance over its
    // (real) timeout. The first upstream attempt is proof that it did.
    await waitForCallCount(callsBefore + 1);
    // Flush the attempt's cloned-body classification into its backoff timer.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(advanceMs);
  }

  return pending;
}

function expectBodies(calls, body) {
  expect(calls).not.toHaveLength(0);
  for (const call of calls) expect(bodyOf(call)).toEqual(body);
}

function expectSessions(calls, matcher) {
  for (const call of calls) expect(sessionOf(call)).toMatch(matcher);
}

describe("OpenCodeExecutor overload retry", () => {
  it("retries the transient free-lane 429 on one session and returns the recovered stream", async () => {
    baseExecuteMock
      .mockResolvedValueOnce(upstream(429, OVERLOAD))
      .mockResolvedValueOnce(upstream(429, OVERLOAD))
      .mockResolvedValueOnce(upstream(200, "data: ok\n\n"));
    const log = { debug: vi.fn() };
    const body = makeBody("overload-recovered");

    const result = await run(new OpenCodeExecutor("opencode", {}), { log, body, advanceMs: 60_000 });

    expect(baseExecuteMock).toHaveBeenCalledTimes(3);
    const calls = baseExecuteMock.mock.calls;
    expectBodies(calls, body);
    // One egress selection and one session own the whole retry loop.
    expectSessions(calls, OPENCODE_SESSION_RE);
    expect(new Set(calls.map(sessionOf)).size).toBe(1);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("data: ok\n\n");
    // The retry is observable to --debug users, like the base retry path.
    expect(log.debug).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenNthCalledWith(1, "RETRY", expect.stringContaining("overloaded"));
    expect(log.debug).toHaveBeenNthCalledWith(2, "RETRY", expect.stringContaining("overloaded"));
    // A transient overload must not be treated as a spent session or egress.
    expect(hasActiveDirectCooldown()).toBe(false);
    expect(getEgressCooldown(CONFIRMED_DIRECT_ID)).toBeNull();
  });

  it("stops after eight attempts, hands the last 429 back intact, and keeps the session for the next request", async () => {
    let attempt = 0;
    baseExecuteMock.mockImplementation(async () => {
      attempt += 1;
      return attempt <= 8 ? upstream(429, OVERLOAD) : upstream(200, "data: ok\n\n");
    });
    const log = { debug: vi.fn() };
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();
    const body = makeBody("overload-exhausted");

    const result = await run(executor, { log, credentials, body, advanceMs: 60_000 });

    expect(baseExecuteMock).toHaveBeenCalledTimes(8);
    const firstCalls = baseExecuteMock.mock.calls;
    expectBodies(firstCalls, body);
    expectSessions(firstCalls, OPENCODE_SESSION_RE);
    expect(new Set(firstCalls.map(sessionOf)).size).toBe(1);
    expect(result.response.status).toBe(429);
    // Reading the cloned body to classify each retry must not consume the
    // response the caller finally receives.
    expect(await result.response.text()).toBe(OVERLOAD);
    // Exhausted overload is transient: no rotation and no cooldown.
    expect(hasActiveDirectCooldown()).toBe(false);
    expect(getEgressCooldown(CONFIRMED_DIRECT_ID)).toBeNull();
    expect(log.debug).toHaveBeenCalledTimes(7);

    // The next successful request reuses the already-minted session.
    const nextBody = makeBody("after-overload");
    const recovered = await run(executor, { credentials, body: nextBody });

    expect(baseExecuteMock).toHaveBeenCalledTimes(9);
    const calls = baseExecuteMock.mock.calls;
    expectBodies(calls.slice(0, 8), body);
    expect(bodyOf(calls[8])).toEqual(nextBody);
    expect(recovered.response.status).toBe(200);
    expect(await recovered.response.text()).toBe("data: ok\n\n");
    expect(new Set(calls.map(sessionOf)).size).toBe(1);
  });

  it("does not retry other upstream failures", async () => {
    baseExecuteMock.mockResolvedValueOnce(upstream(500, '{"error":"boom"}'));
    const body = makeBody("server-error");

    const result = await run(new OpenCodeExecutor("opencode", {}), { body });

    expect(baseExecuteMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(baseExecuteMock.mock.calls[0])).toEqual(body);
    expect(result.response.status).toBe(500);
    expect(await result.response.text()).toBe('{"error":"boom"}');
  });

  it("stops at once when the caller has already aborted", async () => {
    baseExecuteMock.mockResolvedValue(upstream(429, OVERLOAD));
    const controller = new AbortController();
    controller.abort();
    const body = makeBody("pre-aborted");

    const result = await run(new OpenCodeExecutor("opencode", {}), {
      body,
      signal: controller.signal,
    });

    expect(baseExecuteMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(baseExecuteMock.mock.calls[0])).toEqual(body);
    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toBe(OVERLOAD);
  });

  it("aborts during backoff instead of sleeping out the schedule", async () => {
    baseExecuteMock.mockImplementation(async () => upstream(429, OVERLOAD));
    const controller = new AbortController();
    const callsBefore = baseExecuteMock.mock.calls.length;

    const pending = new OpenCodeExecutor("opencode", {}).execute({
      model: MODEL,
      body: makeBody("abort-mid-backoff"),
      stream: true,
      credentials: {},
      signal: controller.signal,
    });
    const settled = pending.then(() => "resolved", (e) => e.name);

    // Wait for the cold-cache probe + first upstream attempt, then flush the
    // attempt into its backoff sleep before aborting.
    await waitForCallCount(callsBefore + 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await settled).toBe("AbortError");
    expect(baseExecuteMock).toHaveBeenCalledTimes(1);
  });
});

// #5559: spent/flagged minted sessions must not be reused indefinitely.
// Quota rotates immediately for one retry; 403 invalidates for the next call.
// Overload retries preserve the session, and native sessions never rotate.
describe("OpenCodeExecutor session invalidation", () => {
  it("reuses one stable session across successful requests", async () => {
    baseExecuteMock.mockImplementation(async () => upstream(200, "data: ok\n\n"));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();

    await run(executor, { credentials, body: makeBody("stable-1") });
    await run(executor, { credentials, body: makeBody("stable-2") });

    expect(baseExecuteMock).toHaveBeenCalledTimes(2);
    const calls = baseExecuteMock.mock.calls;
    expectSessions(calls, OPENCODE_SESSION_RE);
    expect(sessionOf(calls[1])).toBe(sessionOf(calls[0]));
  });

  it("retries a spent quota 429 once on a rotated session, then reuses the recovered session", async () => {
    baseExecuteMock
      .mockImplementationOnce(async () => upstream(429, FREE_USAGE))
      .mockImplementationOnce(async () => upstream(200, "data: ok\n\n"))
      .mockImplementationOnce(async () => upstream(200, "data: next\n\n"));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();
    const body = makeBody("quota-retry");

    const result = await run(executor, { credentials, body });

    // The quota retry happens immediately, on a freshly minted session.
    expect(baseExecuteMock).toHaveBeenCalledTimes(2);
    const retried = baseExecuteMock.mock.calls;
    expectBodies(retried, body);
    expectSessions(retried, OPENCODE_SESSION_RE);
    const [firstSession, recoveredSession] = retried.map(sessionOf);
    expect(recoveredSession).not.toBe(firstSession);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("data: ok\n\n");
    expect(hasActiveDirectCooldown()).toBe(false);

    // The next request must keep the session that recovered, not mint again.
    const nextBody = makeBody("quota-next");
    const next = await run(executor, { credentials, body: nextBody });

    expect(baseExecuteMock).toHaveBeenCalledTimes(3);
    const calls = baseExecuteMock.mock.calls;
    expect(bodyOf(calls[2])).toEqual(nextBody);
    expect(sessionOf(calls[2])).toBe(recoveredSession);
    expect(next.response.status).toBe(200);
    expect(await next.response.text()).toBe("data: next\n\n");
  });

  it("hands a persistent quota 429 back intact and cools the real confirmed egress", async () => {
    // Fresh Response per attempt: each 429 is classified and later delivered.
    baseExecuteMock.mockImplementation(async () => upstream(429, FREE_USAGE));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();
    const body = makeBody("quota-persistent");

    const result = await run(executor, { credentials, body });

    expect(baseExecuteMock).toHaveBeenCalledTimes(2);
    const calls = baseExecuteMock.mock.calls;
    expectBodies(calls, body);
    expectSessions(calls, OPENCODE_SESSION_RE);
    expect(sessionOf(calls[1])).not.toBe(sessionOf(calls[0]));
    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toBe(FREE_USAGE);

    // The egress was really confirmed by the loopback probe, so the real
    // cooldown state must contain it (default cooldown is 60 s).
    expect(hasActiveDirectCooldown()).toBe(true);
    const cooldown = getEgressCooldown(CONFIRMED_DIRECT_ID);
    expect(cooldown).not.toBeNull();
    expect(cooldown.retryAfterMs).toBeGreaterThan(0);
    expect(cooldown.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("drops the session after a 403 so the next request re-mints", async () => {
    baseExecuteMock
      .mockImplementationOnce(async () => upstream(403, FREE_TIER))
      .mockImplementationOnce(async () => upstream(200, "data: ok\n\n"));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();

    const first = await run(executor, { credentials, body: makeBody("forbidden") });
    expect(first.response.status).toBe(403);
    expect(baseExecuteMock).toHaveBeenCalledTimes(1);

    const second = await run(executor, { credentials, body: makeBody("forbidden-next") });
    expect(second.response.status).toBe(200);
    expect(baseExecuteMock).toHaveBeenCalledTimes(2);

    const calls = baseExecuteMock.mock.calls;
    expectSessions(calls, OPENCODE_SESSION_RE);
    expect(sessionOf(calls[1])).not.toBe(sessionOf(calls[0]));
    // A 403 is a session rejection, not an egress cooldown trigger.
    expect(hasActiveDirectCooldown()).toBe(false);
  });

  it("keeps the session through overload retries", async () => {
    baseExecuteMock
      .mockImplementationOnce(async () => upstream(429, OVERLOAD))
      .mockImplementationOnce(async () => upstream(200, "data: ok\n\n"))
      .mockImplementationOnce(async () => upstream(200, "data: next\n\n"));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();

    await run(executor, { credentials, body: makeBody("overload-session"), advanceMs: 60_000 });
    await run(executor, { credentials, body: makeBody("overload-session-next") });

    expect(baseExecuteMock).toHaveBeenCalledTimes(3);
    const sessions = baseExecuteMock.mock.calls.map(sessionOf);
    expect(new Set(sessions).size).toBe(1);
  });

  it("rotates a translated per-conversation session and reuses the recovered one", async () => {
    baseExecuteMock
      .mockImplementationOnce(async () => upstream(429, FREE_USAGE))
      .mockImplementationOnce(async () => upstream(200, "data: ok\n\n"))
      .mockImplementationOnce(async () => upstream(200, "data: next\n\n"));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = makeCredentials();
    const conversation = `conv-${seq++}`;
    const call = (body) => run(executor, {
      credentials,
      body,
      providerSessionId: conversation,
      clientTool: "claude",
    });

    const result = await call(makeBody("translated-conversation"));
    expect(result.response.status).toBe(200);
    expect(baseExecuteMock).toHaveBeenCalledTimes(2);

    const next = await call(makeBody("translated-conversation-next"));
    expect(next.response.status).toBe(200);
    expect(baseExecuteMock).toHaveBeenCalledTimes(3);

    const [firstSession, recoveredSession, reusedSession] = baseExecuteMock.mock.calls.map(sessionOf);
    // Egress id is part of the translation key; the loopback probe confirmed `direct:<ip>`.
    expect(firstSession).toBe(translateSessionId(conversation, "claude", CONFIRMED_DIRECT_ID));
    expect(recoveredSession).toMatch(OPENCODE_SESSION_RE);
    expect(recoveredSession).not.toBe(firstSession);
    expect(reusedSession).toBe(recoveredSession);
  });

  it("never touches a client-supplied native session", async () => {
    const native = "ses_0123456789abABCDEFGHIJKLMN";
    baseExecuteMock.mockImplementation(async () => upstream(429, FREE_USAGE));
    const executor = new OpenCodeExecutor("opencode", {});
    const credentials = { rawHeaders: { "x-opencode-session": native } };

    const first = await run(executor, { credentials, body: makeBody("native") });

    // Native sessions cannot be rotated, so the quota 429 is surfaced as-is
    // (with the egress cooled) after exactly one upstream attempt.
    expect(first.response.status).toBe(429);
    expect(baseExecuteMock).toHaveBeenCalledTimes(1);
    expect(sessionOf(baseExecuteMock.mock.calls[0])).toBe(native);

    expect(await first.response.text()).toBe(FREE_USAGE);
    expect(getEgressCooldown(CONFIRMED_DIRECT_ID)).not.toBeNull();

    // Reset real egress cooldown/cache so the next request reaches upstream;
    // this does not touch sessions. A second quota rejection must still send
    // the native header unchanged and must not trigger an immediate retry.
    resetEgressState();
    const second = await run(executor, { credentials, body: makeBody("native-next") });

    expect(second.response.status).toBe(429);
    expect(await second.response.text()).toBe(FREE_USAGE);
    expect(baseExecuteMock).toHaveBeenCalledTimes(2);
    expect(baseExecuteMock.mock.calls.map(sessionOf)).toEqual([native, native]);
    expectBodies(baseExecuteMock.mock.calls.slice(0, 1), makeBody("native"));
    expectBodies(baseExecuteMock.mock.calls.slice(1), makeBody("native-next"));
    expect(getEgressCooldown(CONFIRMED_DIRECT_ID)).not.toBeNull();
  });

  it("forgetOpencodeSession ignores ids it never minted", () => {
    expect(forgetOpencodeSession("ses_unknown")).toBe(false);
    expect(forgetOpencodeSession(undefined)).toBe(false);
  });
});
