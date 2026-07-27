import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { runWebDraft } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One-shot draft. Nothing in the web UI calls this any more — Compose talks to
 * `/api/chat/stream` — but it is still routable, and it ran the full drafting
 * pipeline (retrieval + several model calls) for anyone signed in, paid or not.
 * Gated like every other paid web route until it's either deleted or wired back
 * up to a caller.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "draft");
  if (limited) return limited;

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
