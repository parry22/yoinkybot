import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { scanBuyerSignals } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A scan runs paid searches + embeddings + up to a handful of composition loops.
export const maxDuration = 300;

export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const res = await scanBuyerSignals(user.id);
    return NextResponse.json(res);
  } catch (err) {
    console.error("buyer radar scan failed", err);
    return NextResponse.json({ error: "scan failed" }, { status: 500 });
  }
}
