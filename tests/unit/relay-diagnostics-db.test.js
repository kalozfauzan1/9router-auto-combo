// OpenCode relay diagnostics — persistence in the real proxyPools JSON column.
// Runs against an isolated DATA_DIR with the real SQLite adapter and localDb.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OPENCODE_RELAY_DIAGNOSTIC_KEY } from "@/shared/utils/relayDiagnostic.js";

const ABUSE_403_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
  },
});

let tempDir;
let db;
let relayDiag;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-relay-diag-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/localDb.js");
  relayDiag = await import("@/lib/network/opencodeRelayDiagnostics.js");
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("OpenCode relay diagnostic persistence", () => {
  it("stores the latest failure on the pool JSON data, independently from testStatus/lastError/updatedAt", async () => {
    const pool = await db.createProxyPool({ name: "Relay A", proxyUrl: "https://relay-a.example.com/relay" });
    const before = await db.getProxyPoolById(pool.id);

    const recorded = await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${pool.id}`,
      status: 403,
      errorText: ABUSE_403_BODY,
      provider: "opencode",
      model: "deepseek-v4.1-flash-free",
    });

    expect(recorded).toMatchObject({ active: true, kind: "abuse", status: 403 });

    const after = await db.getProxyPoolById(pool.id);
    const diag = after[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(diag).toMatchObject({
      active: true,
      kind: "abuse",
      status: 403,
      model: "deepseek-v4.1-flash-free",
    });
    expect(diag.detail).toContain("abusive traffic");
    expect(Number.isNaN(Date.parse(diag.lastIncidentAt))).toBe(false);

    // Generic status and routing-visible fields are untouched.
    expect(after.testStatus).toBe(before.testStatus);
    expect(after.lastError).toBe(before.lastError);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.isActive).toBe(true);
  });

  it("records a newer incident over the previous one (latest failure wins)", async () => {
    const pool = await db.createProxyPool({ name: "Relay A", proxyUrl: "https://relay-a.example.com/relay" });
    await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${pool.id}`, status: 500, errorText: "upstream exploded", provider: "opencode",
    });
    await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${pool.id}`, status: 403, errorText: ABUSE_403_BODY, provider: "opencode",
    });

    const diag = (await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(diag.kind).toBe("abuse");
    expect(diag.status).toBe(403);
  });

  it("does not record for other providers or non-pool connections", async () => {
    const pool = await db.createProxyPool({ name: "Relay A", proxyUrl: "https://relay-a.example.com/relay" });

    expect(await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${pool.id}`, status: 403, errorText: ABUSE_403_BODY, provider: "openai",
    })).toBeNull();
    expect(await relayDiag.recordOpencodeRelayFailure({
      connectionId: "noauth", status: 403, errorText: ABUSE_403_BODY, provider: "opencode",
    })).toBeNull();
    expect(await relayDiag.recordOpencodeRelayFailure({
      connectionId: "conn-1", status: 403, errorText: ABUSE_403_BODY, provider: "opencode",
    })).toBeNull();

    expect((await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY]).toBeUndefined();
  });

  it("stores no headers and no raw secrets in the persisted diagnostic", async () => {
    const pool = await db.createProxyPool({ name: "Relay A", proxyUrl: "https://relay-a.example.com/relay" });
    const raw = 'Authorization: Bearer sk-live-SECRET1234567890 {"x-api-key":"HEADERSECRET"} https://relay.example.com/x?token=TOKSECRET';
    await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${pool.id}`, status: 401, errorText: raw, provider: "opencode",
    });

    const diag = (await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(diag.kind).toBe("auth");
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain("SECRET1234567890");
    expect(serialized).not.toContain("HEADERSECRET");
    expect(serialized).not.toContain("TOKSECRET");
    expect(Object.keys(diag)).not.toContain("headers");
    expect(diag.detail.length).toBeLessThanOrEqual(300);
  });

  it("fail-open: an unknown pool id never throws and records nothing", async () => {
    await expect(relayDiag.recordOpencodeRelayFailure({
      connectionId: "proxy:missing-pool", status: 403, errorText: ABUSE_403_BODY, provider: "opencode",
    })).resolves.toBeNull();
  });
});

describe("OpenCode relay diagnostic recovery", () => {
  it("clears the active warning on a successful OpenCode request via the same pool, retaining the incident", async () => {
    const pool = await db.createProxyPool({ name: "Relay R", proxyUrl: "https://relay-r.example.com/relay" });
    await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${pool.id}`, status: 403, errorText: ABUSE_403_BODY,
      provider: "opencode", model: "deepseek-v4.1-flash-free",
    });
    const incident = (await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];

    const cleared = await relayDiag.clearOpencodeRelayWarning({ connectionId: `proxy:${pool.id}`, provider: "opencode" });

    expect(cleared).toMatchObject({ active: false, kind: "abuse", status: 403 });
    expect(cleared.lastIncidentAt).toBe(incident.lastIncidentAt);
    expect(cleared.detail).toBe(incident.detail);
    expect(Date.parse(cleared.lastRecoveredAt)).toBeGreaterThanOrEqual(Date.parse(incident.lastIncidentAt));

    const after = (await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(after.active).toBe(false);
    expect(after.lastIncidentAt).toBe(incident.lastIncidentAt);
    expect(after.detail).toContain("abusive traffic");
  });

  it("does not clear the warning for another provider or another pool", async () => {
    const poolA = await db.createProxyPool({ name: "Relay A2", proxyUrl: "https://relay-a2.example.com/relay" });
    const poolB = await db.createProxyPool({ name: "Relay B2", proxyUrl: "https://relay-b2.example.com/relay" });
    await relayDiag.recordOpencodeRelayFailure({
      connectionId: `proxy:${poolA.id}`, status: 403, errorText: ABUSE_403_BODY, provider: "opencode",
    });

    expect(await relayDiag.clearOpencodeRelayWarning({ connectionId: `proxy:${poolA.id}`, provider: "openai" })).toBeNull();
    expect(await relayDiag.clearOpencodeRelayWarning({ connectionId: `proxy:${poolB.id}`, provider: "opencode" })).toBeNull();

    expect((await db.getProxyPoolById(poolA.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY].active).toBe(true);
  });

  it("leaves an already-recovered diagnostic untouched (no repeated recovery write)", async () => {
    const pool = await db.createProxyPool({ name: "Relay R2", proxyUrl: "https://relay-r2.example.com/relay" });
    await relayDiag.recordOpencodeRelayFailure({ connectionId: `proxy:${pool.id}`, status: 403, errorText: ABUSE_403_BODY, provider: "opencode" });
    await relayDiag.clearOpencodeRelayWarning({ connectionId: `proxy:${pool.id}`, provider: "opencode" });

    expect(await relayDiag.clearOpencodeRelayWarning({ connectionId: `proxy:${pool.id}`, provider: "opencode" })).toBeNull();
    expect((await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY].active).toBe(false);
  });

  it("a new failure after recovery flips the warning back to active and drops lastRecoveredAt", async () => {
    const pool = await db.createProxyPool({ name: "Relay R3", proxyUrl: "https://relay-r3.example.com/relay" });
    await relayDiag.recordOpencodeRelayFailure({ connectionId: `proxy:${pool.id}`, status: 500, errorText: "upstream exploded", provider: "opencode" });
    await relayDiag.clearOpencodeRelayWarning({ connectionId: `proxy:${pool.id}`, provider: "opencode" });
    await relayDiag.recordOpencodeRelayFailure({ connectionId: `proxy:${pool.id}`, status: 403, errorText: ABUSE_403_BODY, provider: "opencode" });

    const diag = (await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(diag.active).toBe(true);
    expect(diag.kind).toBe("abuse");
    expect(diag.lastRecoveredAt).toBeNull();
  });

  it("a generic proxy ping success does not clear an active OpenCode relay warning", async () => {
    const pool = await db.createProxyPool({ name: "Relay R4", proxyUrl: "https://relay-r4.example.com/relay" });
    await relayDiag.recordOpencodeRelayFailure({ connectionId: `proxy:${pool.id}`, status: 403, errorText: ABUSE_403_BODY, provider: "opencode" });

    // Same write the generic /api/proxy-pools/[id]/test success performs.
    await db.updateProxyPool(pool.id, {
      testStatus: "active", lastTestedAt: new Date().toISOString(), lastError: null, isActive: true,
    });

    const after = await db.getProxyPoolById(pool.id);
    expect(after.testStatus).toBe("active");
    expect(after[OPENCODE_RELAY_DIAGNOSTIC_KEY].active).toBe(true);
    expect(after[OPENCODE_RELAY_DIAGNOSTIC_KEY].kind).toBe("abuse");
  });
});

// Runs last: the mock + resetModules would otherwise leak into the real-DB tests above.
describe("OpenCode relay diagnostic fail-open against a broken DB layer", () => {
  it("a throwing DB layer never rejects the caller and records nothing", async () => {
    vi.doMock("@/lib/localDb", () => ({
      getProxyPoolById: async () => { throw new Error("db down"); },
      updateProxyPoolDataField: async () => { throw new Error("db down"); },
    }));
    vi.resetModules();
    const failing = await import("@/lib/network/opencodeRelayDiagnostics.js");

    await expect(failing.recordOpencodeRelayFailure({
      connectionId: "proxy:pool-a", status: 403, errorText: ABUSE_403_BODY, provider: "opencode",
    })).resolves.toBeNull();
    await expect(failing.clearOpencodeRelayWarning({
      connectionId: "proxy:pool-a", provider: "opencode",
    })).resolves.toBeNull();
  });
});
