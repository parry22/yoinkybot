import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import {
  runAutomationInterviewStreaming,
  ModerationError,
  type AgentEvent,
  type InterviewMessage,
} from "@yoink/backend/web";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The final turn builds the agent AND runs it once (draft generation included),
// so the last request in an interview is the long one.
export const maxDuration = 300;

/**
 * One turn of the Auto Agent setup conversation.
 *
 * STATELESS: the client posts the whole transcript each turn and the server
 * re-derives the spec from it (backend automations/interview.ts). That means a
 * late correction - "actually, weekly" - is picked up without an edit path, and
 * there's no half-finished interview state to store or sweep.
 *
 * The transcript is user-authored either way, so it carries no more trust than a
 * single typed message would; the moderation gate runs on it inside the engine.
 */
const MAX_MESSAGES = 40;
const MAX_CONTENT = 2000;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user))) return Response.json({ error: "upgrade_required" }, { status: 402 });
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "automation_interview");
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { messages?: unknown };
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: InterviewMessage[] = raw
    .slice(-MAX_MESSAGES)
    .map((m) => m as { role?: unknown; content?: unknown })
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, MAX_CONTENT) }))
    .filter((m) => m.content.trim().length > 0);

  if (messages.length === 0) return Response.json({ error: "say something to start" }, { status: 400 });

  return sseResponse(async (emit) => {
    try {
      await runAutomationInterviewStreaming(user.id, messages, emit as (e: AgentEvent) => void);
    } catch (err) {
      if (err instanceof ModerationError) {
        emit({ type: "error", message: err.reason });
        return;
      }
      console.error("automation interview turn failed", err);
      emit({ type: "error", message: "That turn broke on my side - try again." });
    }
  });
}
