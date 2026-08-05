import { z } from "zod";

/**
 * Tool contract for the daily viral case-study agent (viral-case-study.v1).
 * Schemas only - executors live in jobs/viral-benchmark.ts. WHICH tweet is
 * surfaced was decided in code (trends/viral-scoring.ts); these tools only let
 * the model ground the suggested angle in the user's own voice/pillars/memory -
 * the same three the reply-drafting agent uses, no new plumbing.
 */
export const viralToolSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("get_voice_profile") }),
  z.object({ name: z.literal("get_content_pillars") }),
  z.object({ name: z.literal("search_memory"), query: z.string().min(1) }),
]);

export type ViralTool = z.infer<typeof viralToolSchema>;
