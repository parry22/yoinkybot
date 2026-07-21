import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { runWebDraft } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { topic?: unknown };
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) return NextResponse.json({ error: "give me something to write about" }, { status: 400 });

  try {
    const { messages } = await runWebDraft(user, "x", topic);
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("web draft failed", err);
    return NextResponse.json({ error: "draft failed" }, { status: 500 });
  }
}
