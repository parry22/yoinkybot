import type { Prompt } from "./types.js";

export interface ClassifyMentionVars {
  content: string;
  authorHandle: string;
  userHandle: string;
  positions: string[];
}

/**
 * Cheap-tier signal extraction on one incoming public mention. These booleans
 * feed the deterministic reply-worthy scorer - this call classifies, it never
 * decides whether the mention deserves attention.
 */
export const classifyMention: Prompt<ClassifyMentionVars> = {
  id: "classify-mention",
  version: 1,
  tier: "cheap",
  system: `You classify one public reply/mention directed at a person. Three signals, judged strictly:

- is_question: does it contain a DIRECT question aimed at them - something they could actually
  answer? Rhetorical flourishes and questions aimed at the void are false.
- is_substantive_challenge: does it meaningfully push back on something they've said (their stated
  positions are provided)? Generic agreement, compliments, emoji, "this", "so true", spam, and
  vague negativity without an argument are all false. A real counter-argument or a specific
  factual objection is true.
- sentiment: positive | neutral | negative toward them or their work.

Respond with ONLY valid JSON:
{"sentiment":"positive|neutral|negative","is_question":true|false,"is_substantive_challenge":true|false}`,
  render: (v) =>
    `THEIR STATED POSITIONS (for judging whether this challenges one):\n${
      v.positions.length ? v.positions.map((p) => `- ${p}`).join("\n") : "(none extracted)"
    }\n\nMENTION from @${v.authorHandle} to @${v.userHandle}:\n${v.content}`,
};
