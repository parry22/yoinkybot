import { z } from "zod";

/**
 * Tool contract for the reply-drafting agent (reply-draft.v2). Schemas only -
 * no imports from the rest of the engagement layer (same rule as
 * telegram/chat-tools.ts); executors live in reply-agent.ts.
 *
 * Reply-worthiness is decided in engagement/scoring.ts BEFORE any of this
 * runs - these tools only let the model ground one already-selected reply.
 * The mention being drafted for is fixed in the loop's context, so the
 * tweet-scoped tools take no id argument.
 */
export const replyToolSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("search_memory"), query: z.string().min(1) }),
  z.object({ name: z.literal("get_voice_profile") }),
  z.object({ name: z.literal("get_content_pillars") }),
  // The full parent thread, not just the single tweet the scorer flagged.
  z.object({ name: z.literal("get_thread_context") }),
  // Deterministic visibility/timing facts (engagement/heuristics.ts) - the
  // model reasons over this data, it doesn't generate it.
  z.object({ name: z.literal("get_engagement_heuristics") }),
]);

export type ReplyTool = z.infer<typeof replyToolSchema>;
