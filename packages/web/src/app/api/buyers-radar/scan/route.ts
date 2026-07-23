import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { scanBuyerSignals } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A scan runs paid searches + embeddings + up to a handful of composition loops.
export const maxDuration = 300;

export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Paid-only — a scan spends real twitterapi.io + LLM budget. The per-plan
  // monthly cap (Growth 25 / Scale ∞) is enforced inside scanBuyerSignals.
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });
  try {
    const res = await scanBuyerSignals(user.id);
    return NextResponse.json(res);
  } catch (err) {
    console.error("buyer radar scan failed", err);
    return NextResponse.json({ error: "scan failed" }, { status: 500 });
  }
}
