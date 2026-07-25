/**
 * Buyer Radar composition step. A prospect tweet that already cleared BOTH gates
 * (deterministic intent + semantic niche) is handed to a bounded agent loop that
 * pulls grounding (the user's ICP, voice, positions, pillars, and — the moat —
 * their own prior take via search_memory) and drafts one approval-only reply in
 * the user's voice. The model may DECLINE (fires:false); code never lets it widen
 * the set. The agent is an upgrade, not a dependency: on loop error it falls back
 * to a single-shot compose (same posture as consistency/check.ts).
 */
import { z } from "zod";
import { config } from "../config.js";
import { type ToolLoopStep } from "../llm/tool-loop.js";
import { runAgentLoop } from "../agent-runtime/run-agent-loop.js";
import { llmCall } from "../llm/gateway.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile } from "../strategist/profile.js";
import { activePositions } from "../memory/positions.js";
import { searchTweets } from "../capture/imports/twitterapi-io.js";
import { buyerOutreach } from "../prompts/buyer-outreach.v1.js";
import { casualize, enforceStyle } from "../prompts/style.js";
import { buyerToolSchema } from "./tools.js";
import { getIcp } from "./icp.js";
import type { GatedCandidate } from "./niche-gate.js";

export interface BuyerOutreach {
  fires: boolean;
  intentType: string;
  /** Yoinky's own casual rationale (chatter). */
  why: string;
  /** The reply to the prospect, feed voice (empty when fires:false). */
  draftReply: string;
  receiptRef: string | null;
  steps: ToolLoopStep[];
}

const outputSchema = z.object({
  fires: z.boolean().catch(false),
  intent_type: z.string().catch(""),
  why: z.string().catch(""),
  draft_reply: z.string().catch(""),
  receipt_ref: z.string().nullish().catch(null),
});

/**
 * Compose an outreach reply for one gated candidate. `intentType` on the result
 * is authoritative from the candidate's provenance (code-decided); the model's
 * claim is ignored for the stored value.
 */
export async function composeOutreach(userId: string, candidate: GatedCandidate): Promise<BuyerOutreach> {
  const tweet = candidate.tweet;
  const [positions, icp] = await Promise.all([activePositions(userId), getIcp(userId)]);

  const executors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    search_memory: async (args) => {
      const rows = await hybridSearch(userId, String(args.query ?? ""), 5);
      if (rows.length === 0) return "nothing in memory matches — draft from positions/voice, lead with real POV not a pitch";
      return rows
        .map((m) => `- [${m.id}] (${m.kind}, ${m.created_at.slice(0, 10)}) ${m.content.slice(0, 280)}`)
        .join("\n");
    },
    get_icp: async () => {
      if (!icp) return "no ICP set";
      return [
        icp.product_oneliner ? `product: ${icp.product_oneliner}` : "",
        icp.buyer_description ? `buyer: ${icp.buyer_description}` : "",
        icp.competitor_terms.length ? `competitors: ${icp.competitor_terms.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    get_voice_profile: async () => {
      const profile = await currentVoiceProfile(userId);
      return profile?.traits
        ? JSON.stringify(profile.traits).slice(0, 900)
        : "no voice profile built yet — default to plain, blunt, no filler";
    },
    get_positions: async () => {
      if (positions.length === 0) return "no active positions yet";
      return positions
        .slice(0, 12)
        .map((p) => `- ${p.statement}`)
        .join("\n");
    },
    get_content_pillars: async () => {
      const profile = await getProfile(userId);
      if (!profile) return "no brand profile yet";
      return [
        profile.niche ? `niche: ${profile.niche}` : "",
        profile.content_pillars.length ? `pillars: ${profile.content_pillars.join("; ")}` : "no pillars set",
        profile.topics_off_limits.length ? `OFF-LIMITS topics: ${profile.topics_off_limits.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    get_thread_context: async () => {
      const conversationId = tweet.conversationId;
      if (!conversationId) return "couldn't resolve the thread — treat the prospect tweet as standalone";
      try {
        const thread = await searchTweets(`conversation_id:${conversationId} lang:en`, {
          queryType: "Latest",
          maxPages: 1,
        });
        if (thread.length === 0) return "thread lookup returned nothing — treat as standalone";
        return thread
          .slice(0, 10)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((t) => `@${t.authorHandle}: ${t.text.slice(0, 240)}`)
          .join("\n");
      } catch (err) {
        return `thread lookup failed (${err instanceof Error ? err.message : "error"}) — treat as standalone`;
      }
    },
  };

  const renderUser = (notes: string[]): string =>
    buyerOutreach.render({
      prospect: { authorHandle: tweet.authorHandle, content: tweet.text, url: tweet.url },
      intentType: candidate.provenance,
      positions: positions.map((p) => p.statement),
      toolNotes: notes,
      toolCallsRemaining: Math.max(0, config.MAX_BUYER_TOOL_CALLS - notes.length),
    });

  let output: z.infer<typeof outputSchema>;
  let steps: ToolLoopStep[] = [];
  try {
    const res = await runAgentLoop("buyer", {
      userId,
      eventType: "compose",
      tier: buyerOutreach.tier,
      system: buyerOutreach.system,
      renderUser,
      toolSchema: buyerToolSchema,
      executors,
      outputSchema,
      maxToolCalls: config.MAX_BUYER_TOOL_CALLS,
      maxTokens: 700,
    });
    output = res.output;
    steps = res.steps;
  } catch (err) {
    // The agent is an upgrade, not a dependency — fall back to a single-shot
    // compose (no tools) rather than dropping the candidate on a loop error.
    console.error("buyer outreach agent failed; falling back to single-shot compose", err);
    const res = await llmCall({
      userId,
      eventType: "compose",
      tier: buyerOutreach.tier,
      system: buyerOutreach.system,
      user: renderUser([]),
      json: true,
      maxTokens: 700,
    });
    output = outputSchema.parse(res.parsed);
  }

  // fires only counts if there's an actual draft to approve.
  const fires = output.fires && output.draft_reply.trim().length > 0;
  return {
    fires,
    intentType: candidate.provenance,
    why: fires ? casualize(output.why) : "",
    draftReply: fires ? enforceStyle(output.draft_reply) : "",
    receiptRef: output.receipt_ref ?? null,
    steps,
  };
}
