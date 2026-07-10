import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES, CASUAL_VOICE } from "./style.js";

export interface PlanV2Vars {
  headline: string;
  fingerprint: string;
  ownedPositions: string[];
  unsaidPatterns: Array<{ idea: string; evidence: string }>;
  profileSummary: string; // the stated Stage 1-7 profile
  gapSummary: string; // the computed gap (positioning off %, goal mix, etc.)
  primaryGoal: string | null;
  postingCapacity: number | null;
}

/**
 * Stage 11: the three-month plan. Unlike plan.v1 (throughline + unlock + outside-in
 * for the legacy cold flow), this derives the plan from the STATED profile and the
 * measured GAP: a repositioning statement that names the biggest shift, three
 * month-by-month phases each tied to the stated goal, the unlock list as the named
 * first pieces, and the outside-in instruction. Cadence is NOT asked, it's the
 * stated posting capacity.
 */
export const planV2: Prompt<PlanV2Vars> = {
  id: "plan-three-month",
  version: 2,
  tier: "frontier",
  system: `You are the strategist turning the gap analysis into a three-month plan that closes it.
Everything must derive from THIS person's stated profile, their diagnosis, and the measured gap.
Never a generic content calendar. Never invent claims about them.

Produce:
1. REPOSITIONING — one sentence naming the single biggest shift needed to close the largest gap
   you were shown. Concrete, not "post more".
2. THROUGHLINE — one sentence: the specific position they should become known for, serving their
   stated primary goal.
3. MONTHS — exactly three phases, month by month (not week by week). Each has a label and a clear
   objective tied to the stated goal. Shape the arc so month one closes the sharpest positioning
   gap, month two builds the content pillar or muscle that's currently missing, month three targets
   the audience behavior needed to actually hit the goal. Objectives are specific to them.
4. UNLOCK LIST — take their unsaid patterns and sequence them by which moves the stated goal most,
   first. These are the named first pieces of content. For each: the idea and a one-line rationale
   tying it to the goal.
5. OUTSIDE-IN — a short standing instruction (2-3 sentences) for the live discourse moments Yoinky
   should watch for and bring them, given the throughline and goal.

${CHAT_STYLE_RULES}

${CASUAL_VOICE}

Respond with ONLY valid JSON:
{"repositioning":"...","throughline":"...","months":[{"label":"Month 1: ...","objective":"..."},{"label":"Month 2: ...","objective":"..."},{"label":"Month 3: ...","objective":"..."}],"unlock_list":[{"idea":"...","rationale":"...","priority":1}],"outside_in":"..."}
Order unlock_list by priority ascending (1 = do first). Exactly three months.`,
  render: (v) =>
    `THEIR STATED PROFILE:\n${v.profileSummary}\n\n` +
    `PRIMARY GOAL: ${v.primaryGoal ?? "(not stated)"}\n` +
    `HONEST POSTING CAPACITY: ${v.postingCapacity ? `${v.postingCapacity} posts/week` : "(not stated)"}\n\n` +
    `THE MEASURED GAP (what the plan has to close):\n${v.gapSummary}\n\n` +
    `DIAGNOSIS HEADLINE: ${v.headline}\nINTELLECTUAL FINGERPRINT: ${v.fingerprint}\n\n` +
    `OWNED POSITIONS:\n${v.ownedPositions.map((p) => `- ${p}`).join("\n") || "(none)"}\n\n` +
    `UNSAID PATTERNS (candidate first pieces):\n${v.unsaidPatterns.map((u) => `- ${u.idea} (${u.evidence})`).join("\n") || "(none)"}`,
};
