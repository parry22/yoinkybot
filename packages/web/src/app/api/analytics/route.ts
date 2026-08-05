import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getAnalytics } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const value = new URL(req.url).searchParams.get("platform");
  const platform = value === "linkedin" ? "linkedin" : "x";
  return NextResponse.json(await getAnalytics(user.id, platform));
}
