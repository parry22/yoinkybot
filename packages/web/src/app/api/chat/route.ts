import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { runWebChatTurn } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Parity with Telegram (chat is walled once the trial lapses) — no LLM spend for free users.
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });

  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "empty message" }, { status: 400 });

  try {
    const { messages } = await runWebChatTurn(user, text);
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("web chat turn failed", err);
    return NextResponse.json({ error: "chat failed" }, { status: 500 });
  }
}
