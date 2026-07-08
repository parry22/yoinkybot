import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES } from "./style.js";

export interface MacroMatchVars {
  discourse: Array<{ title: string; snippet: string; url: string }>;
  positions: Array<{ id: string; statement: string }>;
  themes: string[];
}

export const macroMatch: Prompt<MacroMatchVars> = {
  id: "macro-match",
  version: 1,
  tier: "frontier",
  system: `You gate a rare, premium notification: "the internet is talking about the exact
thing this person has a stated position on, right now."

The bar is HIGH. Fire only when a live discourse item and a stated position collide so
directly that the person could post their existing take today and it would land in the
conversation. Topic adjacency is NOT a match. General relevance is NOT a match.
A false positive here damages trust more than any other failure in the product —
when unsure, return no match.

why_now is shown directly to the user, so it must sound like you talking to them, not a report.
${CHAT_STYLE_RULES}

Respond with ONLY valid JSON:
{"match":null} or
{"match":{"position_id":"...","url":"...","title":"...","why_now":"one sharp sentence connecting their position to this moment"}}`,
  render: ({ discourse, positions, themes }) =>
    `Recent themes: ${themes.join(", ")}\n\nStated positions:\n${positions
      .map((p) => `[${p.id}] ${p.statement}`)
      .join("\n")}\n\nLive discourse:\n${discourse
      .map((d) => `- ${d.title} — ${d.snippet} (${d.url})`)
      .join("\n")}`,
};
