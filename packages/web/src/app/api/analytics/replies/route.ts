import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getReplyAnalytics } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const data = await getReplyAnalytics(user.id);
    return NextResponse.json(data);
  } catch (err) {
    console.error("reply analytics failed", err);
    return NextResponse.json({ error: "reply analytics failed" }, { status: 500 });
  }
}
