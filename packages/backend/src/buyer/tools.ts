import { z } from "zod";

/**
 * Buyer Radar composition-agent tool schemas. Schemas ONLY — no buyer-layer
 * imports (the chat-tools.ts rule), so this file can't create an import cycle.
 * Executors are wired at the callsite in radar-agent.ts. Discriminated union on
 * `name`, matching the runToolLoop envelope contract.
 */
export const buyerToolSchema = z.discriminatedUnion("name", [
  // The user's own prior take on the prospect's exact pain — the moat. Lead with
  // genuine POV / "I wrote about this", not a pitch.
  z.object({ name: z.literal("search_memory"), query: z.string().min(1) }),
  z.object({ name: z.literal("get_icp") }),
  z.object({ name: z.literal("get_voice_profile") }),
  z.object({ name: z.literal("get_positions") }),
  z.object({ name: z.literal("get_content_pillars") }),
  z.object({ name: z.literal("get_thread_context") }),
]);
export type BuyerTool = z.infer<typeof buyerToolSchema>;
