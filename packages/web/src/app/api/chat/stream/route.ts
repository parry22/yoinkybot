import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { boundedText } from "@/lib/input";
import { runWebChatTurnStreaming, type AgentEvent } from "@yoink/backend/web";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The chat turn as Server-Sent Events, so the UI can show what the agent is
 * doing while it works instead of a silent spinner. Same brain, same tools, same
 * paywall as `/api/chat` — that non-streaming route stays for any caller that
 * just wants the messages as one blob.
 *
 * Streaming works on the Node runtime (Fluid Compute); no `edge` needed.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user))) return Response.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "chat");
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = boundedText(body.text);
  if (!text) return Response.json({ error: "empty message" }, { status: 400 });

  return sseResponse(async (emit) => {
    try {
      await runWebChatTurnStreaming(user, text, emit as (e: AgentEvent) => void);
    } catch (err) {
      console.error("streamed chat turn failed", err);
      emit({ type: "error", message: "That turn failed on our side — try again." });
    }
  });
}
