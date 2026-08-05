import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getSocialConnectStatus } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getSocialConnectStatus(user.id));
}
