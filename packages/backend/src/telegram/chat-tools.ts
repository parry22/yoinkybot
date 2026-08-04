import { z } from "zod";

/**
 * The chat brain's tool contract. Schemas only — no imports from the rest of
 * the telegram layer, so both the conversation parser and the executor can
 * depend on this file without creating a module cycle.
 *
 * Every tool here maps 1:1 onto an existing slash-command code path; the tool
 * layer exists so plain language reaches the same functionality without the
 * user having to know the command. The chat brain may call several of these in
 * one turn, one at a time, up to MAX_TOOL_CALLS_PER_TURN (see converse.v3 +
 * conversation.ts); each call's delivery is persisted as its own turn fragment.
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
  z.object({
    name: z.literal("repurpose_x_post"),
    /** Omit for the latest owned X post already in connected history. */
    url: z.string().optional(),
  }),
  z.object({ name: z.literal("search_memory"), question: z.string().min(1) }),
  // What's happening RIGHT NOW on a topic: live X search + cached trends + news.
  // The counterpart to search_memory — that one looks inward at what the user has
  // said, this one looks outward at what the world is saying.
  z.object({ name: z.literal("find_trends"), topic: z.string().min(1) }),
  // Two-three ways they could take a topic, grounded in live research + their own
  // positions. The move when they want to post about something they haven't
  // thought out loud about yet, so there is nothing in memory to draft from.
  z.object({ name: z.literal("offer_angles"), topic: z.string().min(1) }),
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
  z.object({
    name: z.literal("schedule_post"),
    platform: z.enum(["x", "linkedin"]),
    content: z.string().default(""),
    /** Set after repurpose_x_post so its staged source media is scheduled too. */
    repurposedContentId: z.string().uuid().optional(),
    // Resolved to an absolute ISO instant by the model, using the CURRENT TIME
    // injected into its context — never a relative phrase like "tomorrow 9am".
    when: z.string().min(1),
  }),
  // User is correcting how a past post was read ("that was a joke", "that
  // wasn't sincere") — the model resolves WHICH field and the corrected value
  // from what they said; the executor resolves WHICH post via search.
  z.object({
    name: z.literal("correct_classification"),
    query: z.string().min(1),
    field: z.enum(["rhetorical_mode", "sincerity_register", "motive"]),
    correctedValue: z.string().min(1),
  }),
  // Destructive: never fires the wipe itself. Offers the same clr:confirm /
  // clr:cancel button pair the old /clear command did, so nothing is deleted
  // without an explicit tap.
  z.object({ name: z.literal("clear_everything") }),
]);

export type ChatTool = z.infer<typeof chatToolSchema>;

/** Parse a maybe-tool from the LLM envelope; malformed/unknown tools degrade to none. */
export function parseChatTool(raw: unknown): ChatTool | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = chatToolSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
