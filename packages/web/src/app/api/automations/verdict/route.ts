import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
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
  const instruction = typeof body.instruction === "string" ? body.instruction : undefined;
  return NextResponse.json(await actOnRunWeb(user.id, runId, action, instruction));
}
