import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { actOnRunWeb } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // "edit" re-drafts via the model

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { runId?: unknown; action?: unknown; instruction?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : "";
  const action = body.action === "approve" || body.action === "reject" || body.action === "edit" ? body.action : null;
  if (!runId || !action) return NextResponse.json({ error: "runId and action required" }, { status: 400 });
  // Approving/rejecting an agent draft is the paid Auto Agent loop, and "edit"
  // re-drafts through the model — so the whole route is gated, like every other
  // route that spends money (buyers-radar, inspiration, chat). An expired user
  // who still has approvals pending gets a 402 rather than free re-drafts.
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "automation_verdict");
  if (limited) return limited;
  const instruction = typeof body.instruction === "string" ? body.instruction : undefined;
  return NextResponse.json(await actOnRunWeb(user.id, runId, action, instruction));
}
