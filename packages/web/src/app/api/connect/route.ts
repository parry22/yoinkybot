import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { runWebConnect } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { platform?: unknown; handle?: unknown };
  const platform = body.platform === "linkedin" ? "linkedin" : "x";
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (!handle) {
    return NextResponse.json(
      { error: platform === "x" ? "enter your X @handle" : "enter your LinkedIn profile URL" },
      { status: 400 },
    );
  }

  try {
    const { messages } = await runWebConnect(user, platform, handle);
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("web connect failed", err);
    return NextResponse.json({ error: "connect failed" }, { status: 500 });
  }
}
