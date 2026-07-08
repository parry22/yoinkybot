import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES } from "./style.js";

export interface PlanVars {
  headline: string;
  fingerprint: string;
  ownedPositions: string[];
  unsaidPatterns: Array<{ idea: string; evidence: string }>;
  goals: Array<{ goal_type: string; detail: string; timeframe: string | null; success: string | null }>;
}

/**
 * Builds the plan's THROUGHLINE (the one position to become known for),
 * UNLOCK LIST (the unsaid ideas, sequenced by impact toward the stated goal),
 * and the OUTSIDE-IN standing instruction. Cadence is elicited from the user
 * separately, not invented here.
 */
export const planPrompt: Prompt<PlanVars> = {
  id: "plan",
  version: 1,
  tier: "frontier",
  system: `You are the strategist turning a diagnosis + the person's stated goal into a plan that
compounds. Be specific to THIS person — never a generic content plan. Ground everything in the
diagnosis and goal provided; do not invent new claims about them.

Produce:
1. THROUGHLINE — one sentence naming the specific angle/position this person should become known
   for. It must derive from their actual intellectual fingerprint, not be invented, and must
   serve their stated goal.
2. UNLOCK LIST — take their unsaid patterns and sequence them by which would move their stated
   goal the most, FIRST. For each: the idea, and a one-line rationale tying it to the goal.
3. OUTSIDE-IN — a short standing instruction (2-3 sentences) describing the kind of live
   discourse moments Yoinky should watch for and connect this person to, given their throughline
   and goal. This guides proactive macro-moment matching.

${CHAT_STYLE_RULES}

Respond with ONLY valid JSON:
{"throughline":"...","unlock_list":[{"idea":"...","rationale":"...","priority":1}],"outside_in":"..."}
Order unlock_list by priority ascending (1 = do first).`,
  render: ({ headline, fingerprint, ownedPositions, unsaidPatterns, goals }) =>
    `DIAGNOSIS HEADLINE: ${headline}\n\nINTELLECTUAL FINGERPRINT: ${fingerprint}\n\n` +
    `OWNED POSITIONS:\n${ownedPositions.map((p) => `- ${p}`).join("\n") || "(none)"}\n\n` +
    `UNSAID PATTERNS (candidate unlocks):\n${unsaidPatterns.map((u) => `- ${u.idea} (${u.evidence})`).join("\n") || "(none)"}\n\n` +
    `THEIR GOAL(S):\n${goals
      .map((g) => `- [${g.goal_type}] ${g.detail}${g.timeframe ? ` — timeframe: ${g.timeframe}` : ""}${g.success ? ` — success: ${g.success}` : ""}`)
      .join("\n")}`,
};
