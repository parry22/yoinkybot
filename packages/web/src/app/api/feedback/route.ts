import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { submitFeedback } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    type?: unknown;
    category?: unknown;
    message?: unknown;
  };
  const type = typeof body.type === "string" ? body.type : "";
  const category = typeof body.category === "string" ? body.category : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  try {
    const res = await submitFeedback(user.id, { type, category, message });
    if (!res.ok) return NextResponse.json({ error: "could not submit" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("feedback submit failed", err);
    return NextResponse.json({ error: "could not submit" }, { status: 500 });
  }
}
