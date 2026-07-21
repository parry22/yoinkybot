import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { setBuyerSignalVerdict } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; verdict?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  const verdict = typeof body.verdict === "string" ? body.verdict : "";
  if (!id || !verdict) return NextResponse.json({ error: "id and verdict required" }, { status: 400 });

  const res = await setBuyerSignalVerdict(user.id, id, verdict);
  if (!res.ok) return NextResponse.json({ error: "bad request" }, { status: 400 });
  return NextResponse.json(res);
}
