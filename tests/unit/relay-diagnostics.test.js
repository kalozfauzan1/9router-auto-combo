// OpenCode relay diagnostics — classification and sanitization (pure helpers).
// TDD cycle 1: explicit FreeTierError abusive-traffic rejection is classified as abuse.
// TDD cycle 2: the real "OpenCode Free Model Gateway Detect Abuse Traffic" wording
// must classify as abuse even without the FreeTierError marker; app_only needs the
// explicit "can only be used from within OpenCode" phrase; 401 keeps auth priority.
import { describe, expect, it } from "vitest";
import {
  classifyOpencodeRelayFailure,
  sanitizeRelayDetail,
} from "@/shared/utils/relayDiagnostic.js";

const ABUSE_403_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account.",
  },
});

const APP_ONLY_403_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
  },
});

describe("relay diagnostic classification", () => {
  it("classifies an explicit FreeTierError abusive-traffic rejection as abuse", () => {
    expect(classifyOpencodeRelayFailure(403, ABUSE_403_BODY)).toBe("abuse");
  });

  it("classifies a non-abuse FreeTierError as the OpenCode app-only rejection", () => {
    expect(classifyOpencodeRelayFailure(403, APP_ONLY_403_BODY)).toBe("app_only");
  });

  it("classifies a 401 upstream rejection as auth/access protection", () => {
    expect(classifyOpencodeRelayFailure(401, "Unauthorized: invalid credentials")).toBe("auth");
  });

  it("never labels a bare 403 (no FreeTierError evidence) as abuse", () => {
    expect(classifyOpencodeRelayFailure(403, "Forbidden")).toBe("other");
    expect(classifyOpencodeRelayFailure(403, "Access denied by relay edge")).toBe("other");
  });

  it("keeps unrelated upstream errors in the other bucket", () => {
    expect(classifyOpencodeRelayFailure(500, "upstream exploded")).toBe("other");
    expect(classifyOpencodeRelayFailure(429, "FreeUsageLimitError")).toBe("other");
  });

  it("classifies the real 'Detect Abuse Traffic' gateway error as abuse", () => {
    expect(
      classifyOpencodeRelayFailure(403, "FreeTierError: OpenCode Free Model Gateway Detect Abuse Traffic"),
    ).toBe("abuse");
    expect(
      classifyOpencodeRelayFailure(
        403,
        JSON.stringify({
          type: "error",
          error: { type: "FreeTierError", message: "OpenCode Free Model Gateway Detect Abuse Traffic" },
        }),
      ),
    ).toBe("abuse");
  });

  it("classifies clear abuse wording as abuse even without the FreeTierError marker", () => {
    expect(classifyOpencodeRelayFailure(403, "OpenCode Free Model Gateway: detect abuse traffic from this IP")).toBe("abuse");
    expect(classifyOpencodeRelayFailure(403, "gateway: detected abusive traffic from this IP address")).toBe("abuse");
  });

  it("requires the explicit app-only phrase for app_only (a vague FreeTierError is other)", () => {
    const vagueFreeTier = JSON.stringify({
      type: "error",
      error: { type: "FreeTierError", message: "Free tier temporarily unavailable for this request" },
    });
    expect(classifyOpencodeRelayFailure(403, vagueFreeTier)).toBe("other");
    expect(
      classifyOpencodeRelayFailure(403, "OpenCode's free tier can only be used from within OpenCode"),
    ).toBe("app_only");
  });

  it("lets 401 auth take priority over abuse wording in the body", () => {
    expect(classifyOpencodeRelayFailure(401, ABUSE_403_BODY)).toBe("auth");
    expect(classifyOpencodeRelayFailure(401, "detect abuse traffic")).toBe("auth");
  });
});

describe("relay diagnostic detail sanitization", () => {
  it("removes bearer tokens, query credentials, and key-like values from stored detail", () => {
    const raw = [
      "Authorization: Bearer sk-live-SECRET1234567890",
      "called https://opencode.ai/inference?key=QUERYSECRET&token=TOKSECRET",
      'with {"x-api-key":"HEADERSECRET"}',
      "via https://user:URLPASS@relay.example.com/path",
    ].join(" ");

    const detail = sanitizeRelayDetail(raw);

    expect(detail).not.toContain("SECRET1234567890");
    expect(detail).not.toContain("QUERYSECRET");
    expect(detail).not.toContain("TOKSECRET");
    expect(detail).not.toContain("HEADERSECRET");
    expect(detail).not.toContain("URLPASS");
    expect(detail).toContain("[redacted]");
  });

  it("keeps ordinary upstream error text readable", () => {
    const detail = sanitizeRelayDetail("403 detected abusive traffic from this IP address");
    expect(detail).toBe("403 detected abusive traffic from this IP address");
  });

  it("caps the stored detail length", () => {
    expect(sanitizeRelayDetail("x".repeat(5000)).length).toBeLessThanOrEqual(300);
  });

  it("returns an empty string for non-string error payloads (never serializes objects)", () => {
    expect(sanitizeRelayDetail({ headers: { authorization: "Bearer secret" } })).toBe("");
    expect(sanitizeRelayDetail(null)).toBe("");
    expect(sanitizeRelayDetail(undefined)).toBe("");
  });
});
