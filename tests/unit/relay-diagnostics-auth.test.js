// OpenCode relay diagnostics — auth service + API integration with the real DB.
// Verifies markAccountUnavailable/clearAccountError wiring for the
// `proxy:<poolId>` virtual connections used by auto and direct traffic.
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

const APP_ONLY_403_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
  },
});

let tempDir;
let db;
let auth;
const originalDataDir = process.env.DATA_DIR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-relay-auth-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/localDb.js");
  auth = await import("@/sse/services/auth.js");
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("auth service relay diagnostics integration", () => {
  it("markAccountUnavailable records the OpenCode relay failure on the pool without changing fallback behavior", async () => {
    const pool = await db.createProxyPool({ name: "Relay I1", proxyUrl: "https://relay-i1.example.com/relay" });
    const before = await db.getProxyPoolById(pool.id);

    const result = await auth.markAccountUnavailable(
      `proxy:${pool.id}`, 403, ABUSE_403_BODY, "opencode", "deepseek-v4.1-flash-free",
    );

    expect(result.shouldFallback).toBe(true);
    const after = await db.getProxyPoolById(pool.id);
    expect(after[OPENCODE_RELAY_DIAGNOSTIC_KEY]).toMatchObject({ active: true, kind: "abuse", status: 403 });
    // Generic pool status and routing-visible fields stay untouched.
    expect(after.testStatus).toBe(before.testStatus);
    expect(after.lastError).toBe(before.lastError);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.isActive).toBe(true);
  });

  it("records the app-only rejection distinctly and never as abuse", async () => {
    const pool = await db.createProxyPool({ name: "Relay I2", proxyUrl: "https://relay-i2.example.com/relay" });
    await auth.markAccountUnavailable(`proxy:${pool.id}`, 403, APP_ONLY_403_BODY, "opencode");

    const diag = (await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(diag.kind).toBe("app_only");
    expect(diag.active).toBe(true);
  });

  it("does not record for direct no-auth, non-pool connections, other providers, or non-fallback errors", async () => {
    const pool = await db.createProxyPool({ name: "Relay I3", proxyUrl: "https://relay-i3.example.com/relay" });

    expect((await auth.markAccountUnavailable("noauth", 403, ABUSE_403_BODY, "opencode")).shouldFallback).toBe(false);
    expect((await auth.markAccountUnavailable(`proxy:${pool.id}`, 400, "invalid request", "opencode")).shouldFallback).toBe(false);
    await auth.markAccountUnavailable(`proxy:${pool.id}`, 403, ABUSE_403_BODY, "openai");

    expect((await db.getProxyPoolById(pool.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY]).toBeUndefined();
  });

  it("clearAccountError after an OpenCode success clears only the same pool and keeps the incident", async () => {
    const poolA = await db.createProxyPool({ name: "Relay I4a", proxyUrl: "https://relay-i4a.example.com/relay" });
    const poolB = await db.createProxyPool({ name: "Relay I4b", proxyUrl: "https://relay-i4b.example.com/relay" });
    await auth.markAccountUnavailable(`proxy:${poolA.id}`, 403, ABUSE_403_BODY, "opencode", "deepseek-v4.1-flash-free");
    await auth.markAccountUnavailable(`proxy:${poolB.id}`, 403, ABUSE_403_BODY, "opencode", "deepseek-v4.1-flash-free");
    const credsB = { connectionId: `proxy:${poolB.id}`, providerSpecificData: { connectionProxyPoolId: poolB.id } };

    // Another provider's success must not clear the warning.
    await auth.clearAccountError(`proxy:${poolB.id}`, credsB, "deepseek-v4.1-flash-free", "openai");
    expect((await db.getProxyPoolById(poolB.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY].active).toBe(true);

    // A same-pool OpenCode success clears pool A only.
    await auth.clearAccountError(
      `proxy:${poolA.id}`,
      { connectionId: `proxy:${poolA.id}`, providerSpecificData: { connectionProxyPoolId: poolA.id } },
      "deepseek-v4.1-flash-free",
      "opencode",
    );
    expect((await db.getProxyPoolById(poolA.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY].active).toBe(false);
    expect((await db.getProxyPoolById(poolB.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY].active).toBe(true);

    // The same-pool OpenCode success clears B while retaining its incident.
    const incidentB = (await db.getProxyPoolById(poolB.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    await auth.clearAccountError(`proxy:${poolB.id}`, credsB, "deepseek-v4.1-flash-free", "opencode");
    const afterB = (await db.getProxyPoolById(poolB.id))[OPENCODE_RELAY_DIAGNOSTIC_KEY];
    expect(afterB.active).toBe(false);
    expect(afterB.lastIncidentAt).toBe(incidentB.lastIncidentAt);
    expect(afterB.detail).toBe(incidentB.detail);
  });

  it("exposes the diagnostic through the proxy-pools API the dashboard reads", async () => {
    const pool = await db.createProxyPool({ name: "Relay I5", proxyUrl: "https://relay-i5.example.com/relay" });
    await auth.markAccountUnavailable(`proxy:${pool.id}`, 403, ABUSE_403_BODY, "opencode");

    const { GET } = await import("@/app/api/proxy-pools/route.js");
    const res = await GET(new Request("http://localhost/api/proxy-pools?includeUsage=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.proxyPools.find((p) => p.id === pool.id);
    expect(row).toBeTruthy();
    expect(row[OPENCODE_RELAY_DIAGNOSTIC_KEY]).toMatchObject({ active: true, kind: "abuse", status: 403 });
  });
});
