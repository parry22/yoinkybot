import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  extractTranscriptToKnowledge,
  resolveWorkspaceContext,
  reviewKnowledgeObject,
  type PermissionLevel,
  type WorkspaceSourceType,
  consumeRateLimit,
  rateLimitMessage,
} from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) return NextResponse.json({ error: "No active workspace." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const limit=await consumeRateLimit(user.id,"company_knowledge");if(!limit.ok)return NextResponse.json({error:rateLimitMessage(limit.retryAfterSec)},{status:429,headers:{"retry-after":String(limit.retryAfterSec)}});
    const objects = await extractTranscriptToKnowledge(user.id, workspace.id, {
      title: typeof body.title === "string" ? body.title : "",
      transcript: typeof body.transcript === "string" ? body.transcript : "",
      speakerExpertId: typeof body.speakerExpertId === "string" ? body.speakerExpertId : null,
      permissionLevel: typeof body.permissionLevel === "string" ? body.permissionLevel as PermissionLevel : "internal",
      sourceType: typeof body.sourceType === "string" ? body.sourceType as WorkspaceSourceType : "founder_interview",
    });
    return NextResponse.json({ objects }, { status: 201 });
  } catch (error) {
    console.error("knowledge extraction failed", error);
    const message = error instanceof Error ? error.message : "Could not extract knowledge.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) return NextResponse.json({ error: "No active workspace." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { objectId?: unknown; status?: unknown };
  if (typeof body.objectId !== "string" || typeof body.status !== "string") {
    return NextResponse.json({ error: "Object and review action are required." }, { status: 400 });
  }
  try {
    const object = await reviewKnowledgeObject(
      user.id,
      workspace.id,
      body.objectId,
      body.status as "reviewed" | "approved" | "rejected" | "archived",
    );
    return NextResponse.json({ object });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not review knowledge.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
