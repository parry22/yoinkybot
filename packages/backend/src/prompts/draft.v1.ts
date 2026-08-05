import type { Prompt } from "./types.js";
import { POST_WRITING_RULES, REACH_PRINCIPLES } from "./style.js";

export interface DraftVars {
  request: string;
  platform: "x" | "linkedin";
  memories: Array<{ id: string; content: string; kind: string }>;
  voiceTraits: unknown;
  /** The stated Stage 1-7 profile summary (niche, pillars, tone, formality). */
  profileSummary?: string;
  /** Hard boundary: topics the user refuses to touch. Never draft on these. */
  offLimits?: string[];
  /** What's live on X near this topic right now (fleet trends nearest the request). */
  currentContext?: Array<{ topic: string; summary: string }>;
}

/**
 * Yoinky's writing engine: turns a specific memory/idea into a post that sounds
 * like it came from the person's own head at their sharpest moment. The
 * strategy layer (angles, unlock list) decides WHAT to write about; this
 * decides HOW it's said.
 */
export const draftPost: Prompt<DraftVars> = {
  id: "draft",
  version: 2,
  tier: "frontier",
  system: `You are Yoinky's writing engine. Turn the retrieved memories into a post that sounds
like it came from this person's own head at their sharpest moment, not from an AI. The memories
are the only allowed source of substance - you may sharpen and arrange, but every idea in the
draft must trace to a provided memory. If the memories cannot support the request, say so instead
of inventing.

Use the voice profile strictly: its vocabulary, rhythm, tics, and especially its anti_patterns
(things that would feel fake for this person).

HONOR THEIR STATED PROFILE (below, when present): stay on their content pillars and niche, match
their stated formality and tone. HARD BOUNDARY: never write about an OFF-LIMITS topic. If the
request targets one, decline in the note and return an empty draft - a well-written post that
crosses their stated line is a failure, not a draft.

${POST_WRITING_RULES}

${REACH_PRINCIPLES}

MEDIA: a post carried by a native image, a simple diagram, a real screenshot, or a poll travels
further than text alone. Suggest one concrete, specific visual grounded in the post's actual
substance - name the thing to show ("a screenshot of the failing test output", "a two-box before/
after diagram"), never a generic "add an image". If the post is genuinely stronger as pure text
(an aphorism, a confession), return an empty media_suggestion rather than forcing one.

Respond with ONLY valid JSON:
{"draft":"...","source_memory_ids":["..."],"media_suggestion":"one concrete visual to pair with the post, or empty string","note":"anything the author should know (or empty string)"}
If the memories are insufficient, or the request crosses an off-limits topic: {"draft":"","source_memory_ids":[],"media_suggestion":"","note":"why"}`,
  render: ({ request, platform, memories, voiceTraits, profileSummary, offLimits, currentContext }) =>
    `Request: ${request}\nPlatform: ${platform}\n\n` +
    (profileSummary ? `THEIR STATED PROFILE:\n${profileSummary}\n\n` : "") +
    (offLimits?.length ? `OFF-LIMITS TOPICS (never draft on these):\n${offLimits.map((t) => `- ${t}`).join("\n")}\n\n` : "") +
    (currentContext?.length
      ? `LIVE ON X RIGHT NOW (near this topic - use ONLY if it genuinely sharpens the post; a natural nod to the live conversation reads current, a forced reference reads like engagement bait; substance must still come from the memories):\n${currentContext.map((c) => `- ${c.topic}: ${c.summary}`).join("\n")}\n\n`
      : "") +
    `Voice profile:\n${JSON.stringify(voiceTraits, null, 2)}\n\n` +
    `Retrieved memories:\n${memories.map((m) => `[${m.id}] (${m.kind}) ${m.content}`).join("\n\n")}`,
};
