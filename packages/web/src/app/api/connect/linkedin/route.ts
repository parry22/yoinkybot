import { NextResponse } from "next/server";
import { connectLinkedInProfileFromWeb } from "@yoink/backend/web";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { profileUrl?: unknown };
  if (typeof body.profileUrl !== "string") return NextResponse.json({ error: "profile URL required" }, { status: 400 });
  try {
    await connectLinkedInProfileFromWeb(user.id, body.profileUrl);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "could not connect LinkedIn" }, { status: 400 });
  }
}
