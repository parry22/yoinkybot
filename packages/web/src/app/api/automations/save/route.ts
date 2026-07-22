import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { saveAutomationFromWeb, ModerationError } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> & { id?: string };
  try {
    const view = await saveAutomationFromWeb(user.id, body, typeof body.id === "string" ? body.id : undefined);
    return NextResponse.json({ automation: view });
  } catch (err) {
    if (err instanceof ModerationError) return NextResponse.json({ error: err.reason }, { status: 400 });
    console.error("save automation failed", err);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
}
