import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES } from "./style.js";

export interface ConsistencyVars {
  draft: string;
  positions: Array<{ id: string; statement: string; first_stated_at: string; last_affirmed_at: string }>;
  /** The active plan throughline, if any — flag drift away from it, not just contradiction. */
  throughline?: string;
}

export const consistencyCheck: Prompt<ConsistencyVars> = {
  id: "consistency-check",
  version: 1,
  tier: "frontier",
  system: `You check a draft post against a person's previously stated positions. Compare
MEANING, not wording — a rephrased belief is consistent; a genuine reversal is not.

A contradiction means: a reasonable reader who saw both statements would think the author
changed their mind or is being inconsistent. Nuance, added caveats, or narrower scope are
NOT contradictions. Topic overlap alone is NOT a contradiction.

False positives destroy trust in this feature. When unsure, do not flag.

If a THROUGHLINE is given, also judge whether this draft pulls AWAY from the position they're
trying to become known for — off-brand drift is worth surfacing even when it's not a hard
contradiction. Report it as a contradiction with position_id "throughline".

For each REAL contradiction, return the position id and a one-sentence explanation of the
specific tension. Also note reinforcements (draft strongly restates a position) — these are
informational, not flags.

${CHAT_STYLE_RULES}

Respond with ONLY valid JSON:
{"contradictions":[{"position_id":"...","explanation":"..."}],
 "reinforcements":[{"position_id":"..."}]}`,
  render: ({ draft, positions, throughline }) =>
    `DRAFT:\n${draft}\n\n${throughline ? `THROUGHLINE (what they want to be known for): ${throughline}\n\n` : ""}STATED POSITIONS:\n${positions
      .map((p) => `[${p.id}] (first: ${p.first_stated_at.slice(0, 10)}, last affirmed: ${p.last_affirmed_at.slice(0, 10)}) ${p.statement}`)
      .join("\n")}`,
};
