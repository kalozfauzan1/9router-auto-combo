import { NextResponse } from "next/server";
import { getModelRanks, setModelRanks } from "@/lib/db/index.js";
import { parseRanksPayload } from "open-sse/services/autoCombo.js";
import { getAvailableAutoModels } from "@/sse/services/autoComboService.js";

export const dynamic = "force-dynamic";

// GET /api/models/ranks - manual intelligence ranking (higher number = smarter)
// Also returns the server-side candidate models so the dashboard does not need
// to call the public, API-key-guarded /api/v1/models from the browser.
// An eligibility lookup failure is surfaced as a non-2xx error (never a 200 with
// an empty candidate list) so the dashboard shows a load error instead of a
// false "no eligible models".
export async function GET() {
  try {
    const [ranks, models] = await Promise.all([
      getModelRanks(),
      getAvailableAutoModels(),
    ]);
    return NextResponse.json({ ranks, models });
  } catch (error) {
    console.log("Error fetching model ranks:", error);
    return NextResponse.json({ error: "Failed to fetch model ranks" }, { status: 500 });
  }
}

// PUT /api/models/ranks - replace ranking map { "provider/model": rank }
// All-or-nothing: malformed payloads are rejected with 400 and the existing map
// is left untouched.
export async function PUT(request) {
  try {
    const body = await request.json();
    const parsed = parseRanksPayload(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const ranks = await setModelRanks(parsed.ranks);
    return NextResponse.json({ ranks });
  } catch (error) {
    console.log("Error updating model ranks:", error);
    return NextResponse.json({ error: "Failed to update model ranks" }, { status: 500 });
  }
}
