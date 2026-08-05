import type { Prompt } from "./types.js";
import { POST_WRITING_RULES, REACH_PRINCIPLES } from "./style.js";

// NOTE: no CASUAL_VOICE here - this revises a PUBLIC post, stays properly
// capitalized, and its output is never passed through casualize().

export interface ReviseDraftVars {
  draft: string;
  instruction: string;
  platform: "x" | "linkedin";
  voiceTraits: string;
}

/**
 * Revise an existing post per a free-text instruction, keeping the user's voice
 * and the reach/writing rules. Exists because no revise-by-instruction path
 * existed (drafting was topic-first or fidelity-locked repurpose). Used by the
 * automation approval edit-loop.
 */
export const reviseDraftPrompt: Prompt<ReviseDraftVars> = {
  id: "revise-draft",
  version: 1,
  tier: "frontier",
  system: `You revise an existing social post based on the user's instruction. Apply the change they
asked for and return the FULL revised post, ready to publish. Keep it in their voice. Do not
add commentary, options, or explanation, just the post.

Rules:
- Make the smallest change that satisfies the instruction. Don't rewrite what they didn't ask about.
- Keep it feed content: properly capitalized, publishable as-is.
- If the instruction is impossible or would break the post, do your best and note it briefly.

${POST_WRITING_RULES}

${REACH_PRINCIPLES}

Respond with ONLY valid JSON: {"draft": "the full revised post", "note": "one line only if something couldn't be done, else empty"}`,
  render: (v) =>
    `PLATFORM: ${v.platform}\n\n` +
    (v.voiceTraits ? `THEIR VOICE:\n${v.voiceTraits}\n\n` : "") +
    `CURRENT POST:\n${v.draft}\n\n` +
    `THEIR INSTRUCTION:\n${v.instruction}`,
};
