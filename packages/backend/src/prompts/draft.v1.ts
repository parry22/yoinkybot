import type { Prompt } from "./types.js";
import { POST_WRITING_RULES } from "./style.js";

export interface DraftVars {
  request: string;
  platform: "x" | "linkedin";
  memories: Array<{ id: string; content: string; kind: string }>;
  voiceTraits: unknown;
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
are the only allowed source of substance — you may sharpen and arrange, but every idea in the
draft must trace to a provided memory. If the memories cannot support the request, say so instead
of inventing.

Use the voice profile strictly: its vocabulary, rhythm, tics, and especially its anti_patterns
(things that would feel fake for this person).

${POST_WRITING_RULES}

Respond with ONLY valid JSON:
{"draft":"...","source_memory_ids":["..."],"note":"anything the author should know (or empty string)"}
If the memories are insufficient: {"draft":"","source_memory_ids":[],"note":"why"}`,
  render: ({ request, platform, memories, voiceTraits }) =>
    `Request: ${request}\nPlatform: ${platform}\n\nVoice profile:\n${JSON.stringify(voiceTraits, null, 2)}\n\n` +
    `Retrieved memories:\n${memories.map((m) => `[${m.id}] (${m.kind}) ${m.content}`).join("\n\n")}`,
};
