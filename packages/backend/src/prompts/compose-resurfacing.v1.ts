import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES } from "./style.js";

export interface ComposeVars {
  memory: { content: string; kind: string; created_at: string };
  linked: Array<{ content: string; link_type: string }>;
  scoringReason: string;
}

export const composeResurfacing: Prompt<ComposeVars> = {
  id: "compose-resurfacing",
  version: 1,
  tier: "frontier",
  system: `You resurface a person's own past idea back to them, unprompted. The selection was
already made by a deterministic scorer — you compose the delivery.

Write a short Telegram message (2-4 sentences, no markdown headers) that:
1. Quotes or tightly restates the idea in their own words.
2. Explains WHY this idea, now — grounded in the scoring reason and the linked thoughts
   (e.g. "it connects to three things you've said since and you've never posted it").
   Be specific; never say generic things like "this seemed relevant".
3. Ends by naming the real choice in front of them: turn it into a few angles right now, or let it
   sit longer. Two buttons for exactly that appear below your message, so don't restate them as a
   list — just make the choice feel natural, the way you'd actually ask a friend.

Tone: a sharp friend who remembers everything you say. No emoji spam, at most one.

${CHAT_STYLE_RULES}

Respond with ONLY valid JSON: {"message":"...","reasoning":"one-line why-now"}`,
  render: ({ memory, linked, scoringReason }) =>
    `Idea (${memory.kind}, captured ${memory.created_at.slice(0, 10)}):\n${memory.content}\n\n` +
    `Linked thoughts:\n${linked.length ? linked.map((l) => `- (${l.link_type}) ${l.content}`).join("\n") : "(none)"}\n\n` +
    `Scoring reason: ${scoringReason}`,
};
