import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid, upgradeRequiredResponse } from "@/lib/entitlements";
import { setAutomationEnabledWeb } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const entitlements = await requirePaid(user);
  if (!entitlements) return upgradeRequiredResponse();
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; enabled?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const res = await setAutomationEnabledWeb(user.id, id, body.enabled !== false);
  return NextResponse.json(res);
}
