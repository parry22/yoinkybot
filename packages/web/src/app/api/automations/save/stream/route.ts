import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { saveAutomationStreaming, ModerationError, type AgentEvent } from "@yoink/backend/web";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Create/update an Auto Agent from the composer, streamed. Mirrors
 * `/api/automations/save` (which stays for the non-streaming path) but reports
 * its steps so the page reads like the agent working rather than a button that
 * hangs. Moderation/entitlement rejections arrive as an `error` event with the
 * real reason, since by then we're already committed to a 200 stream.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user))) return Response.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "automation_interview");
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> & { id?: string };
  const id = typeof body.id === "string" && body.id ? body.id : undefined;

  return sseResponse(async (emit) => {
    try {
      await saveAutomationStreaming(user.id, body, emit as (e: AgentEvent) => void, id);
    } catch (err) {
      if (err instanceof ModerationError) {
        emit({ type: "error", message: err.reason });
        return;
      }
      console.error("streamed automation save failed", err);
      emit({ type: "error", message: "Couldn't set that agent up - try again." });
    }
  });
}
