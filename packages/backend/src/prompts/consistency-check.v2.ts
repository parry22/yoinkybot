import type { Prompt } from "./types.js";

export interface ConsistencyAgentVars {
  draft: string;
  /** The ambiguous top matches — more than one prior statement looked plausible. */
  positions: Array<{ id: string; statement: string; first_stated_at: string; last_affirmed_at: string }>;
  throughline?: string;
  /** Compact notes on tools already executed this run. */
  toolNotes: string[];
  toolCallsRemaining: number;
}

/**
 * The agentic consistency check. Runs ONLY when the deterministic ambiguity
 * gate in consistency/check.ts fired (top-2 position matches within
 * CONSISTENCY_AMBIGUITY_DELTA of each other) — the common clean-match case
 * stays on the single-shot v1 compare. This prompt gets research tools so it
 * can find the specific statement the draft actually conflicts with instead of
 * guessing between lookalike positions.
 */
export const consistencyAgent: Prompt<ConsistencyAgentVars> = {
  id: "consistency-check-agent",
  version: 2,
  tier: "frontier",
  system: `You check a draft post against a person's previously stated positions. The draft below
might contradict something they've said before, but the match wasn't clean — more than one prior
statement looked plausible. Before answering, use the tools to find the specific statement
(exact wording, date, source) this draft actually conflicts with, if any.

Do not guess which position it's really about. If after checking, no real conflict remains, say
so — a false "catch" erodes trust in every real one after it. Compare MEANING, not wording:
nuance, added caveats, or narrower scope are NOT contradictions. Topic overlap alone is NOT a
contradiction.

TOOLS — one per response, set "tool" to request it, null when you're ready to answer:
- search_more_positions {query}: broaden past the matches you were given.
- get_position_context {position_id}: the source memories, dates, and surrounding capture behind
  one position, not just its stored statement.
- search_memory {query}: check whether they've since revised this stance somewhere that isn't in
  positions yet.
Stop pulling as soon as you can name the specific conflicting statement or rule a conflict out.

Resolve as exactly one of:
- "intentional_evolution" — the draft knowingly moves past a stated position; cite the old
  statement, its date and source, and why this reads as a deliberate shift, not a slip.
- "catch_it" — the draft contradicts a still-live position; cite the exact prior statement,
  date, and source.
- "no_conflict" — ambiguity resolved, nothing to flag.

Respond with ONLY valid JSON:
{"tool": {"name": "...", ...args} | null,
 "resolution": "intentional_evolution" | "catch_it" | "no_conflict",
 "position_id": "the conflicting position's id, or null",
 "prior_statement": "exact prior statement, or empty",
 "date": "when they said it, or empty",
 "source": "where it came from (memory/import), or empty",
 "explanation": "one sentence naming the specific tension, or why it resolved clean",
 "confidence": 0.0-1.0}
While "tool" is set, the other fields may be placeholders — only your final answer (tool null)
is read.`,
  render: (v) => {
    const notes = v.toolNotes.length
      ? `\n\nWHAT YOU'VE CHECKED SO FAR:\n${v.toolNotes.map((n) => `- ${n}`).join("\n")}\n(Tool calls remaining: ${v.toolCallsRemaining}.)`
      : `\n\n(Tool calls remaining: ${v.toolCallsRemaining}.)`;
    return (
      `DRAFT:\n${v.draft}\n\n` +
      (v.throughline ? `THROUGHLINE (what they want to be known for): ${v.throughline}\n\n` : "") +
      `THE AMBIGUOUS MATCHES (too close to call apart on similarity alone):\n${v.positions
        .map(
          (p) =>
            `[${p.id}] (first: ${p.first_stated_at.slice(0, 10)}, last affirmed: ${p.last_affirmed_at.slice(0, 10)}) ${p.statement}`,
        )
        .join("\n")}${notes}`
    );
  },
};
