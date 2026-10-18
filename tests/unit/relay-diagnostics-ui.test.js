import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RelayDiagnostic from "@/app/(dashboard)/dashboard/proxy-pools/RelayDiagnostic.js";

function render(diagnostic) {
  return renderToStaticMarkup(React.createElement(RelayDiagnostic, { diagnostic }));
}

describe("proxy-pools RelayDiagnostic", () => {
  it("renders nothing when the pool has no diagnostic", () => {
    expect(render(undefined)).toBe("");
    expect(render(null)).toBe("");
  });

  it("renders the abuse warning with localized incident date and error details", () => {
    const html = render({
      active: true,
      kind: "abuse",
      status: 403,
      model: "claude-sonnet-4-5",
      detail: "upstream response: abusive traffic detected (request 123)",
      lastIncidentAt: "2026-01-02T03:04:05.000Z",
    });

    expect(html).toContain(
      "OpenCode detected abusive traffic from this relay IP. Another relay will be tried if available.",
    );
    expect(html).toMatch(/<time datetime="2026-01-02T03:04:05\.000Z">/i);
    expect(html).toContain("Error details");
    expect(html).toContain("Status: 403");
    expect(html).toContain("Model: claude-sonnet-4-5");
    expect(html).toContain("abusive traffic detected (request 123)");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("border-amber-500/30");
    expect(html).toContain("min-w-0");
    expect(html).toContain("break-words");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("renders the recovered confirmation with the recovery date", () => {
    const html = render({
      active: false,
      kind: "auth",
      status: 401,
      lastIncidentAt: "2026-01-02T03:04:05.000Z",
      lastRecoveredAt: "2026-01-03T06:07:08.000Z",
    });

    expect(html).toContain("OpenCode relay recovered.");
    expect(html).toMatch(/<time datetime="2026-01-03T06:07:08\.000Z">/i);
    expect(html).toContain("border-emerald-500/30");
    expect(html).not.toContain("abusive traffic");
  });

  it("labels auth and app_only failures without abuse wording", () => {
    const auth = render({ active: true, kind: "auth", status: 401 });
    expect(auth).toContain(
      "Relay authentication or platform access protection rejected this relay (401). Another relay will be tried if available.",
    );
    expect(auth).not.toContain("abusive traffic");

    const appOnly = render({
      active: true,
      kind: "app_only",
      status: 403,
      detail: "the free tier can only be used from within OpenCode",
    });
    expect(appOnly).toContain("application-only restriction");
    expect(appOnly).not.toContain("abusive traffic");
  });

  it("redacts credential material from the error detail and escapes it as text", () => {
    const html = render({
      active: true,
      kind: "other",
      status: 500,
      detail: 'request failed: https://relay.example.com/v1?token=super-secret-value-123 {"api_key":"leak-me-too"}',
    });

    expect(html).toContain("OpenCode relay request failed. Another relay will be tried if available.");
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("super-secret-value-123");
    expect(html).not.toContain("leak-me-too");
    // angle brackets / quotes from the detail must be HTML-escaped, not markup
    expect(html).not.toContain('{"api_key"');
  });
});
