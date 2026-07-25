import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { runAutomationOnceStreaming, type AgentEvent } from "@yoink/backend/web";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * "Run now", streamed with the run pipeline's own stages (caps → select →
 * moderate → drafting → delivering). `/api/automations/run` stays for the
 * non-streaming path.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user))) return Response.json({ error: "upgrade_required" }, { status: 402 });

  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  return sseResponse(async (emit) => {
    try {
      await runAutomationOnceStreaming(user.id, id, emit as (e: AgentEvent) => void);
    } catch (err) {
      console.error("streamed automation run failed", err);
      emit({ type: "error", message: "Couldn't run that agent — try again." });
    }
  });
}
