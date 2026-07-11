import { z } from "zod";

/**
 * Tool contract for the agentic consistency check (consistency-check.v2).
 * Schemas only — no imports from the rest of the consistency layer, same rule
 * as telegram/chat-tools.ts, so the loop parser and the executors in check.ts
 * can both depend on this file without a module cycle.
 *
 * The loop only runs when a deterministic ambiguity signal fired (top-2
 * position matches too close to call) — code decides WHEN to spend the extra
 * calls, the model never decides to wander.
 */
export const consistencyToolSchema = z.discriminatedUnion("name", [
  // Broaden past the original top-K embed matches when none of them is the
  // position the draft is really about.
  z.object({ name: z.literal("search_more_positions"), query: z.string().min(1) }),
  // The source memories, dates, and surrounding capture behind one position —
  // not just the stored statement string.
  z.object({ name: z.literal("get_position_context"), position_id: z.string().min(1) }),
  // Whether the user has since revised this stance somewhere that isn't in
  // positions yet.
  z.object({ name: z.literal("search_memory"), query: z.string().min(1) }),
]);

export type ConsistencyTool = z.infer<typeof consistencyToolSchema>;
