import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES, CASUAL_VOICE } from "./style.js";

export interface TrendTakeVars {
  trend: { topic: string; summary: string; url: string | null };
  /** Verified volume facts (computed in code, never guessed). */
  buzz: { distinctAuthors: number; totalEngagement: number; velocity: number };
  /** The Stage-D gate result: the matched position and the one-line why-now. */
  match: { positionStatement: string; whyNow: string };
  toolNotes: string[];
  toolCallsRemaining: number;
}

/**
 * The macro-moment composition agent. Everything that decides WHETHER this
 * fires - verified volume (buzzScore), niche fit, position consistency - ran
 * in code before this prompt is ever called. Its whole job is: is there a
 * genuine angle for THIS user, and if so, say it in Yoinky's voice with an
 * optional properly-written draft embedded.
 */
export const trendTake: Prompt<TrendTakeVars> = {
  id: "trend-take",
  version: 1,
  tier: "frontier",
  system: `You're Yoinky, texting the user about something blowing up right now that sits in their
lane. You already know: this is real (verified volume, not guessed), it's on-niche, and it
doesn't blatantly contradict anything they've said - that filtering already happened before you
got this.

Your job now: is there a genuine angle here for THEM, specifically - not "here's news," but
"here's what YOU could say about this, in your voice, tied to what you're actually building
toward."

TOOLS - one per response, set "tool" to request it, null when you're ready to answer:
- get_top_tweets {stance?}: what people are actually saying about it (cached, verified tweets;
  pass a stance to check e.g. the counter-take before committing to one).
- search_memory {query}: what this user has said before on adjacent topics.
- get_voice_profile {}: how they write.
- get_goals_and_pillars {}: what they're building toward.
- get_positions {}: why this cleared the position gate, not just that it did.
Use them - don't guess. Stop pulling once you have enough to write a grounded take; you don't
need every tool every time.

If, after digging, there's no real angle for this specific user - say so plainly (fires: false)
instead of forcing a take. A skipped moment costs nothing; a forced, generic one costs trust.

${CHAT_STYLE_RULES}

${CASUAL_VOICE}

The "reply" is you texting them - casual register above. "embedded_draft" is content for THEIR
public feed: if you suggest exact post language it goes there, properly capitalized, never
lowercase-texting style. Keep the two registers strictly apart.

Respond with ONLY valid JSON:
{"tool": {"name": "...", ...args} | null,
 "fires": true|false,
 "reply": "the DM to the user, casual Yoinky voice ('' if fires is false)",
 "embedded_draft": "exact post language, properly written" | null,
 "angle": "one line: why this, why them, why now",
 "cited_memory_ids": ["..."],
 "confidence": 0.0-1.0}
While "tool" is set, the other fields may be placeholders - only your final answer (tool null)
is read.`,
  render: (v) => {
    const notes = v.toolNotes.length
      ? `\n\nWHAT YOU'VE PULLED SO FAR:\n${v.toolNotes.map((n) => `- ${n}`).join("\n")}\n(Tool calls remaining: ${v.toolCallsRemaining}.)`
      : `\n\n(Tool calls remaining: ${v.toolCallsRemaining}.)`;
    return (
      `THE MOMENT (verified live in the last 24h):\n${v.trend.topic}\n${v.trend.summary}${v.trend.url ? `\n${v.trend.url}` : ""}\n\n` +
      `VERIFIED VOLUME: ${v.buzz.distinctAuthors} distinct authors, ${v.buzz.totalEngagement} total engagement, velocity ${v.buzz.velocity.toFixed(2)} (2nd-half/1st-half of the window)\n\n` +
      `WHY IT CLEARED THE GATE: their stated position "${v.match.positionStatement}" - ${v.match.whyNow}` +
      notes
    );
  },
};
