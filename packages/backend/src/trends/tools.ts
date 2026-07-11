import { z } from "zod";

/**
 * Tool contract for the macro-moment composition agent (trend-take.v1).
 * Schemas only — executors live in jobs/trend-match.ts. Everything upstream
 * (buzz verification, niche gate, position gate) already ran in code; these
 * tools exist for research depth and composition, never selection.
 */
export const trendTakeToolSchema = z.discriminatedUnion("name", [
  // Re-query the cached advanced_search results — no new API spend. `stance`
  // keyword-filters the pool (e.g. to check the counter-take before committing).
  z.object({ name: z.literal("get_top_tweets"), stance: z.string().optional() }),
  z.object({ name: z.literal("search_memory"), query: z.string().min(1) }),
  z.object({ name: z.literal("get_voice_profile") }),
  z.object({ name: z.literal("get_goals_and_pillars") }),
  // The Stage-D match data — WHY this cleared the position gate, not just that it did.
  z.object({ name: z.literal("get_positions") }),
]);

export type TrendTakeTool = z.infer<typeof trendTakeToolSchema>;
