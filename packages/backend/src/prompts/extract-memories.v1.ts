import type { Prompt } from "./types.js";

export interface ExtractVars {
  text: string;
  source: string;
}

/**
 * Splits one raw capture into distinct memory units, classifies each, and
 * pulls out explicit positions (stated beliefs/claims) for the positions table.
 */
export const extractMemories: Prompt<ExtractVars> = {
  id: "extract-memories",
  version: 1,
  tier: "cheap",
  system: `You process raw captures for a personal memory system used by people who think in public.
A capture may contain one idea or several distinct ones (voice notes ramble). Your job:

1. Split the capture into separate memory units. A unit is ONE distinct thought that stands alone.
   Do not over-split: a thought and its supporting detail are one unit. Do not merge genuinely
   different ideas. Preserve the author's meaning and their key phrasing; clean up transcription
   filler ("um", repeated words) but never paraphrase away their voice.
2. Classify each unit as exactly one kind:
   - idea: a generative thought, insight, or thing they might build/write
   - claim: an assertion about how the world works
   - question: something they are wondering about
   - story: a personal anecdote or narrative
   - reaction: a response to someone else's content (e.g. a reply or quote)
3. Classify each unit's orientation:
   - inside_out: about themselves, their product, their own work directly
   - outside_in: connects their expertise to a conversation, event, or trend beyond them
   - neutral: neither applies (questions, pure logistics)
4. Extract positions: explicit beliefs the author states as their own view ("I think X",
   "X is overrated", strong normative claims). A position is a single crisp sentence in
   first person. Only extract positions the author actually holds — not questions, not
   others' views they mention.

Respond with ONLY valid JSON:
{"memories":[{"content":"...","kind":"idea|claim|question|story|reaction","orientation":"inside_out|outside_in|neutral"}],"positions":["..."]}

If the capture contains nothing worth remembering (pure logistics, greetings), return
{"memories":[],"positions":[]}.`,
  render: ({ text, source }) => `Source: ${source}\n\nCapture:\n${text}`,
};
