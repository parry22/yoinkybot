import { z } from "zod";

/**
 * The chat brain's tool contract. Schemas only — no imports from the rest of
 * the telegram layer, so both the conversation parser and the executor can
 * depend on this file without creating a module cycle.
 *
 * Every tool here maps 1:1 onto an existing slash-command code path; the tool
 * layer exists so plain language reaches the same functionality without the
 * user having to know the command. One tool per turn, executed after the
 * conversational reply is sent.
 */
export const chatToolSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("draft_post"),
    platform: z.enum(["x", "linkedin"]).default("x"),
    topic: z.string().min(1),
  }),
  z.object({
    name: z.literal("repurpose"),
    // Mirrors parseRepurposeCommand's forms: reshape to a platform, change
    // format, or synthesize scattered takes on a theme into one piece.
    form: z.enum(["x", "linkedin", "compress", "expand", "synthesis"]),
    text: z.string().min(1),
  }),
  z.object({ name: z.literal("search_memory"), question: z.string().min(1) }),
  z.object({ name: z.literal("check_draft"), text: z.string().min(1) }),
  z.object({ name: z.literal("show_plan") }),
  z.object({ name: z.literal("show_positions") }),
  z.object({ name: z.literal("show_status") }),
  z.object({ name: z.literal("refresh_diagnosis") }),
  z.object({
    name: z.literal("connect_account"),
    platform: z.enum(["x", "linkedin"]),
    handle: z.string().min(1),
  }),
  z.object({ name: z.literal("forget"), query: z.string().min(1) }),
]);

export type ChatTool = z.infer<typeof chatToolSchema>;

/** Parse a maybe-tool from the LLM envelope; malformed/unknown tools degrade to none. */
export function parseChatTool(raw: unknown): ChatTool | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = chatToolSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
