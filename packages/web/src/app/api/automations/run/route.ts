import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { runAutomationOnceWeb } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // drafting can take a bit

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "automation_run");
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  return NextResponse.json(await runAutomationOnceWeb(user.id, id));
}
