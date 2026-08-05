import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { enqueueBuyerScan, buyerScanProgress } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Scan now" is ENQUEUE + POLL, not a synchronous scan (docs/INTERNAL §3n).
 *
 * A scan composes an outreach reply per gated candidate, and with
 * AGENT_RUNTIME_BUYER=sdk each of those spawns a Claude Code subprocess that
 * needs a real filesystem - which a serverless function is not. So the work runs
 * on the Railway backend via pg-boss and this route only starts it and reports
 * progress. That also retires the old 300s-ceiling race against several paid
 * searches plus a handful of composition loops.
 *
 * POST → { jobId }              start (or re-attach to) a scan
 * GET  ?jobId=… → { state, … }  poll it
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Paid-only - a scan spends real twitterapi.io + LLM budget. The per-plan
  // monthly cap (Growth 25 / Scale ∞) is enforced inside the scan itself.
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard. A scan is the single most expensive thing a user can trigger
  // (several paid searches + a composition loop per gated candidate), and the
  // monthly cap is enforced inside the scan - i.e. AFTER the spend starts. This
  // bounds how many can be kicked off in a window.
  const limited = await rateLimited(user.id, "buyer_scan");
  if (limited) return limited;
  try {
    const ticket = await enqueueBuyerScan(user.id);
    // 202: accepted, not finished. The client polls GET for the outcome.
    return NextResponse.json({ jobId: ticket.jobId, state: "queued" }, { status: 202 });
  } catch (err) {
    console.error("buyer radar scan enqueue failed", err);
    return NextResponse.json({ error: "scan failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  try {
    // Ownership is checked inside buyerScanProgress against the job payload, so a
    // guessed jobId reads as "unknown" rather than leaking another user's scan.
    const progress = await buyerScanProgress(user.id, jobId);
    return NextResponse.json(progress);
  } catch (err) {
    console.error("buyer radar scan poll failed", err);
    return NextResponse.json({ error: "poll failed" }, { status: 500 });
  }
}
