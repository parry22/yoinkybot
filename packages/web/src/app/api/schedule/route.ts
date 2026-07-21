import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createWebScheduledPost, ModerationError } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { content?: unknown; scheduledFor?: unknown };
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const scheduledFor = typeof body.scheduledFor === "string" ? body.scheduledFor : "";
  if (!content || !scheduledFor) return NextResponse.json({ error: "content and time required" }, { status: 400 });

  try {
    const res = await createWebScheduledPost(user.id, content, scheduledFor);
    if (!res.ok) return NextResponse.json({ error: res.reason ?? "could not schedule" }, { status: 400 });
    return NextResponse.json({ ok: true, id: res.id });
  } catch (err) {
    if (err instanceof ModerationError) return NextResponse.json({ error: err.reason }, { status: 400 });
    console.error("web schedule failed", err);
    return NextResponse.json({ error: "could not schedule" }, { status: 500 });
  }
}
