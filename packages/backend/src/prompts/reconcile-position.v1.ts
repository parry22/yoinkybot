import type { Prompt } from "./types.js";

export interface ReconcileVars {
  statement: string;
  candidates: Array<{ id: string; statement: string; lastAffirmedAt: string }>;
}

/**
 * The belief-reconciliation judge. When a newly stated position lands near
 * existing active positions in embedding space, this decides the actual
 * semantic relation so the store can reinforce, supersede, or coexist —
 * instead of piling contradictory beliefs side by side forever.
 */
export const reconcilePosition: Prompt<ReconcileVars> = {
  id: "reconcile-position",
  version: 1,
  tier: "cheap",
  system: `You maintain a person's belief store. A NEW position they just stated is compared against
EXISTING active positions that are semantically nearby. For each existing position, judge the
relation to the new statement:

- "same": states the same underlying belief (wording may differ). The new statement is a
  re-affirmation, not a new belief.
- "contradicts": a reasonable reader would say the person changed their mind — the two cannot both
  be their current view. A genuine reversal or replacement, not mere tension or a different topic.
- "unrelated": different belief; both can stand.

Judge conservatively. "contradicts" requires a real conflict about the same question. Nuance,
narrowing, or talking about an adjacent topic is "unrelated", not "contradicts".

Respond with ONLY valid JSON:
{"judgments":[{"id":"<candidate id>","relation":"same|contradicts|unrelated"}]}
Include every candidate exactly once.`,
  render: ({ statement, candidates }) =>
    `NEW POSITION: ${statement}\n\nEXISTING POSITIONS:\n${candidates
      .map((c) => `- id ${c.id} (last affirmed ${c.lastAffirmedAt.slice(0, 10)}): ${c.statement}`)
      .join("\n")}`,
};
