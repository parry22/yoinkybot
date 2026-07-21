import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getAgentState, setAgentEnabled, runAgentCycle } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getAgentState(user.id));
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; on?: boolean };
  try {
    if (body.action === "toggle") {
      await setAgentEnabled(user.id, Boolean(body.on));
      return NextResponse.json({ enabled: Boolean(body.on) });
    }
    if (body.action === "run") {
      const result = await runAgentCycle(user);
      const state = await getAgentState(user.id);
      return NextResponse.json({ result, state });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    console.error("agent action failed", err);
    return NextResponse.json({ error: "agent action failed" }, { status: 500 });
  }
}
