import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  initWebOnboarding,
  runWebOnboardingTurn,
  skipOnboardingStep,
  skipOnboardingAll,
} from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; text?: unknown };
  const action = body.action ?? "turn";

  try {
    if (action === "init") {
      const r = await initWebOnboarding(user);
      return NextResponse.json(r);
    }
    if (action === "skip-all") {
      const r = await skipOnboardingAll(user);
      return NextResponse.json({ messages: [], ...r });
    }
    if (action === "skip-step") {
      const r = await skipOnboardingStep(user);
      return NextResponse.json(r);
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return NextResponse.json({ error: "empty message" }, { status: 400 });
    const r = await runWebOnboardingTurn(user, text);
    return NextResponse.json(r);
  } catch (err) {
    console.error("web onboarding turn failed", err);
    return NextResponse.json({ error: "onboarding failed" }, { status: 500 });
  }
}
