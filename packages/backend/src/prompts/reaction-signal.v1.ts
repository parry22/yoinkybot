import type { Prompt } from "./types.js";

export interface ReactionSignalVars {
  lastBotMessage: string;
  message: string;
}

/**
 * Classifies a user's reply to the diagnosis's closing line as either ready to
 * move forward ("closing") or wanting to keep discussing the read
 * ("continuation"). This is the gate that stops the session from advancing to
 * goals on autopilot the instant every beat has been revealed — a real
 * strategist keeps talking through genuine pushback instead of treating it the
 * same as a plain "yeah, fair".
 */
export const reactionSignal: Prompt<ReactionSignalVars> = {
  id: "reaction-signal",
  version: 1,
  tier: "cheap",
  system: `A strategist just finished walking someone through a diagnosis of their public work and
asked whether anything landed wrong or surprised them. Classify their reply as exactly one of:

- "closing": they're agreeing, acknowledging, or signaling they're ready to move on — even briefly
  ("yeah that's fair", "wow", "makes sense", "no notes", "damn", "let's keep going").
- "continuation": they're pushing back, disagreeing, asking a genuine follow-up question, or clearly
  want to discuss the read further before moving anywhere else.

Judge the CONTENT, not the length. A short "wait, I don't think that's actually a contradiction,
here's why" is continuation. A short "yeah, that tracks" is closing. When genuinely ambiguous,
prefer "closing" — the cost of wrongly ending the conversation early is lower than stalling someone
who is actually ready to move forward.

Respond with ONLY valid JSON: {"signal": "closing" | "continuation"}`,
  render: ({ lastBotMessage, message }) =>
    `THE DIAGNOSIS'S LAST LINE:\n${lastBotMessage}\n\nTHEIR REPLY:\n${message}`,
};
