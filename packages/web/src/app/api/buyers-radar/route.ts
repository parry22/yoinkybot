import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { listBuyerSignals } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const platform = new URL(req.url).searchParams.get("platform") === "linkedin" ? "linkedin" : "x";
  return NextResponse.json({ signals: await listBuyerSignals(user.id, platform) });
}
