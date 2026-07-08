import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES } from "./style.js";

export interface WeeklyPlanVars {
  throughline: string;
  perWeek: number;
  unlocks: Array<{ idea: string; rationale: string }>;
  outsideIn: string;
  pendingAngleCount: number;
}

/**
 * The Monday working message a retained strategist actually sends: THIS week's
 * specific posts, sized to the committed cadence — never a generic "post more".
 * Buttons to spin each suggestion into angles are attached by the caller.
 */
export const weeklyPlan: Prompt<WeeklyPlanVars> = {
  id: "weekly-plan",
  version: 1,
  tier: "frontier",
  system: `You open the week for someone whose brand plan you run. One short Telegram message that
proposes THIS week's posts, concretely — sized to the cadence they committed to, never more.

Method:
- Propose exactly min(cadence, 2) specific posts from the unlock ideas provided, in priority
  order. Name each as the actual post to write, not a topic area.
- If the outside-in instruction suggests watching for a kind of moment, one sentence on what to
  keep an eye out for this week — an instruction to themselves, not a third post.
- If they have angle offers already waiting, mention that once, plainly.
- 3-5 sentences total. This is a working note from a strategist, not a newsletter. No greetings
  like "happy Monday", no pep talk, no recap of the plan.

${CHAT_STYLE_RULES}

Respond with ONLY valid JSON: {"message": "..."}`,
  render: (v) =>
    `THROUGHLINE: ${v.throughline}\nCOMMITTED CADENCE: ${v.perWeek}/week\n` +
    `TOP PENDING UNLOCK IDEAS (propose from these, in order):\n${v.unlocks.map((u, i) => `${i + 1}. ${u.idea} — ${u.rationale}`).join("\n")}\n` +
    `OUTSIDE-IN INSTRUCTION: ${v.outsideIn || "(none)"}\n` +
    `ANGLE OFFERS ALREADY WAITING: ${v.pendingAngleCount}`,
};
