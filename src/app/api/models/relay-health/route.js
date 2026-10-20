import { NextResponse } from "next/server";
import { getAllRelayLkgp, getAllRelayHealth, clearAllRelayHealth, clearAllRelayLkgp } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

/**
 * Keep the entries whose key ends with `suffix` (`<id>:<model>` layout).
 *
 * @param {Record<string, object>} map
 * @param {string} suffix
 * @returns {Record<string, object>}
 */
function pickBySuffix(map, suffix) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (typeof key !== "string" || !key.endsWith(suffix)) continue;
    if (key.length === suffix.length) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Keep the entries whose key starts with `prefix` (`<provider>:<model>` layout).
 *
 * @param {Record<string, object>} map
 * @param {string} prefix
 * @returns {Record<string, object>}
 */
function pickByPrefix(map, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (typeof key !== "string" || !key.startsWith(prefix)) continue;
    out[key] = value;
  }
  return out;
}

// GET /api/models/relay-health - relay LKGP map + per-connection relay health.
// Optional `model` filters both maps by their `<id>:<model>` suffix, optional
// `provider` filters the LKGP map by its `<provider>:<model>` prefix.
export async function GET(request) {
  try {
    const params = new URL(request?.url || "http://localhost/api/models/relay-health").searchParams;
    const model = params.get("model");
    const provider = params.get("provider");

    let lkgp = await getAllRelayLkgp();
    let health = await getAllRelayHealth();

    if (model) {
      const suffix = `:${model}`;
      lkgp = pickBySuffix(lkgp, suffix);
      health = pickBySuffix(health, suffix);
    }

    if (provider) {
      lkgp = pickByPrefix(lkgp, `${provider}:`);
    }

    return NextResponse.json({ lkgp, health, now: Date.now() });
  } catch (error) {
    console.log("Error fetching relay health:", error);
    return NextResponse.json({ error: "Failed to fetch relay health" }, { status: 500 });
  }
}

// DELETE /api/models/relay-health - drop every relay LKGP + health entry.
export async function DELETE() {
  try {
    await clearAllRelayHealth();
    await clearAllRelayLkgp();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error clearing relay health:", error);
    return NextResponse.json({ error: "Failed to clear relay health" }, { status: 500 });
  }
}
