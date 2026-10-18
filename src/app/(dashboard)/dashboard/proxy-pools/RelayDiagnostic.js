"use client";

import React from "react";
import { sanitizeRelayDetail } from "@/shared/utils/relayDiagnostic.js";

// Plain React.createElement (no JSX) so the component is also loadable by the
// Vitest/Vite pipeline, which cannot parse JSX inside a `.js` file.
const h = React.createElement;

/** Parse a stored timestamp; returns null when missing or invalid. */
function parseValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Active-incident banner text for each classified failure kind. */
function activeMessage(kind) {
  if (kind === "abuse") {
    return "OpenCode detected abusive traffic from this relay IP. Another relay will be tried if available.";
  }
  if (kind === "app_only") {
    return "OpenCode rejected this relay: application-only restriction. Another relay will be tried if available.";
  }
  if (kind === "auth") {
    return "Relay authentication or platform access protection rejected this relay (401). Another relay will be tried if available.";
  }
  return "OpenCode relay request failed. Another relay will be tried if available.";
}

/**
 * Latest OpenCode relay diagnostic for one proxy pool.
 * Renders nothing when the pool has no diagnostic yet.
 */
export default function RelayDiagnostic({ diagnostic }) {
  if (!diagnostic) return null;

  const recovered = diagnostic.active === false;
  const kind = typeof diagnostic.kind === "string" ? diagnostic.kind : "other";
  const incidentAt = parseValidDate(diagnostic.lastIncidentAt);
  const recoveredAt = parseValidDate(diagnostic.lastRecoveredAt);

  const detail = sanitizeRelayDetail(diagnostic.detail);
  const hasStatus = diagnostic.status !== undefined && diagnostic.status !== null;
  const hasModel = typeof diagnostic.model === "string" && diagnostic.model.length > 0;
  const hasDetails = hasStatus || hasModel || detail !== "";

  const tone = recovered
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";

  const message = recovered ? "OpenCode relay recovered." : activeMessage(kind);

  const dateRow =
    incidentAt || recoveredAt
      ? h(
          "p",
          { className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] opacity-80" },
          incidentAt
            ? h(
                "span",
                null,
                "Last incident: ",
                h("time", { dateTime: incidentAt.toISOString() }, incidentAt.toLocaleString()),
              )
            : null,
          recoveredAt
            ? h(
                "span",
                null,
                "Recovered: ",
                h("time", { dateTime: recoveredAt.toISOString() }, recoveredAt.toLocaleString()),
              )
            : null,
        )
      : null;

  const detailsBlock = hasDetails
    ? h(
        "details",
        { className: "mt-1 min-w-0" },
        h("summary", { className: "cursor-pointer select-none text-[11px] font-medium opacity-80" }, "Error details"),
        h(
          "div",
          { className: "mt-1 min-w-0 break-words whitespace-pre-wrap text-[11px] opacity-90" },
          hasStatus ? h("div", null, "Status: ", String(diagnostic.status)) : null,
          hasModel ? h("div", null, "Model: ", diagnostic.model) : null,
          detail ? h("div", null, detail) : null,
        ),
      )
    : null;

  return h(
    "div",
    { className: `mt-2 min-w-0 rounded-md border px-3 py-2 text-xs ${tone}` },
    h(
      "p",
      { className: "flex items-start gap-1.5 font-medium" },
      h(
        "span",
        { className: "material-symbols-outlined text-[14px] leading-4 shrink-0", "aria-hidden": "true" },
        recovered ? "check_circle" : "warning",
      ),
      h("span", { className: "min-w-0 break-words whitespace-pre-wrap" }, message),
    ),
    dateRow,
    detailsBlock,
  );
}
