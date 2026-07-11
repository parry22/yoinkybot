import type { Prompt } from "./types.js";
import { ALL_TONE_KEYS, TONE_LABEL } from "../strategist/profile.js";

export interface ExtractVars {
  text: string;
  source: string;
  /** A deterministic, pre-computed series marker (e.g. "day-series",
   *  "tag:buildinpublic") from memory/classification.ts#detectStructuralMarker,
   *  or null when none was found. Told to the model as fact, never asked to
   *  notice it itself. */
  structuralMarker: string | null;
  /** A short per-user calibration note re-derived monthly from their own
   *  corrections (memory/classification.ts consumers) — null until enough
   *  correction history exists. */
  userCalibration: string | null;
}

const toneMenu = ALL_TONE_KEYS.map((k) => `${k}: ${TONE_LABEL[k]}`).join("\n");

/**
 * Splits one raw capture into distinct memory units, classifies each, pulls
 * out explicit positions, AND (v2, added for the classification pass) reads
 * what kind of post the WHOLE capture actually is — its rhetorical mode,
 * sincerity register, and motive. This is a distinct concern from splitting/
 * kind/orientation, called out as its own numbered step: content extraction
 * tells you what a post is about, this tells you what kind of post it is and
 * why it exists. Classified at the CAPTURE level (one register/mode/motive
 * per post), not per memory unit — a post's register doesn't fragment the way
 * its ideas do.
 *
 * The sincerity register is the load-bearing field: jobs/extract.ts gates
 * position emission on it, so a shitpost or bit can never become a stored
 * belief. Confidence must be honest — a garbled or genuinely ambiguous read
 * should say so, never default to a confident "sincere".
 */
export const extractMemories: Prompt<ExtractVars> = {
  id: "extract-memories",
  version: 2,
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
   others' views they mention. IMPORTANT: only extract positions if the capture as a whole
   reads as sincere (see step 6) — a joke stated as a "belief" is not a real position, never
   extract one from a bit, however confidently phrased.

5. Classify the WHOLE capture's rhetorical mode — pick the single best-fitting key from:
${toneMenu}
   Also flag format independently (zero or more, they can co-occur with any mode above):
   thread, single_post, visual_carousel_reference, video_reference.

6. Classify the WHOLE capture's sincerity register — this is the most important call you make.
   Check, in order:
   - Deliberately broken/lowercase-only formatting used as a REGISTER MARKER, not a typo — only
     meaningful if it breaks from how this author normally writes (you don't have their full voice
     profile here, so weight this lightly unless the break is extreme).
   - Structural absurdity or non-sequitur AS THE POINT, rather than a coherent claim or narrative.
   - Exaggeration/hyperbole wildly disproportionate to any real claim — a humor marker, not a
     sincere data-driven take.
   - Contradiction against something the author would sincerely, repeatedly believe — if a claim is
     flatly incompatible with normal human sincerity in context, the NEW post is more likely the
     insincere one, not a real belief reversal.
   Pick exactly one: sincere | ironic | self_deprecating | absurdist | ambiguous.
   - sincere: stated at face value, no irony layer.
   - ironic: says one thing, means the opposite or something more nuanced; humor is structural.
   - self_deprecating: genuine content wrapped in self-directed humor — real signal under the joke.
   - absurdist: humor with no real informational content underneath; the craft IS the point.
   - ambiguous: genuinely unclear even with full context. Use this rather than forcing a guess.
   Give an honest confidence 0-1. LOW confidence on a genuinely unclear post is CORRECT and expected
   — never inflate confidence to seem decisive. A parse-safe default of low-confidence "ambiguous"
   is far better than a wrong confident "sincere".

7. Classify the WHOLE capture's motive — what is this post actually trying to accomplish, distinct
   from what it's about. Pick one: authority_building, relationship_building, audience_growth,
   lead_generation, personal_processing (thinking out loud, no strategic intent),
   community_participation (reply/banter energy, low strategic intent), campaign_installment (part
   of an ongoing declared series). If a STRUCTURAL MARKER is given to you as a fact below, weight
   motive strongly toward campaign_installment with high confidence.

Respond with ONLY valid JSON:
{"memories":[{"content":"...","kind":"idea|claim|question|story|reaction","orientation":"inside_out|outside_in|neutral"}],"positions":["..."],"rhetorical_mode":"<one tone key>","format_flags":["thread"|"single_post"|"visual_carousel_reference"|"video_reference"],"sincerity_register":"sincere|ironic|self_deprecating|absurdist|ambiguous","sincerity_confidence":0.0,"motive":"authority_building|relationship_building|audience_growth|lead_generation|personal_processing|community_participation|campaign_installment","motive_confidence":0.0,"mode_confidence":0.0}

If the capture contains nothing worth remembering (pure logistics, greetings), return
{"memories":[],"positions":[],"rhetorical_mode":"reach.replyguy","format_flags":[],"sincerity_register":"ambiguous","sincerity_confidence":0,"motive":"personal_processing","motive_confidence":0,"mode_confidence":0}.`,
  render: ({ text, source, structuralMarker, userCalibration }) => {
    const lines = [`Source: ${source}`];
    if (structuralMarker) {
      lines.push(
        `STRUCTURAL MARKER DETECTED (fact, computed in code — this post carries a "${structuralMarker}" series marker): weight motive strongly toward campaign_installment, high confidence.`,
      );
    }
    if (userCalibration) {
      lines.push(`THIS USER'S KNOWN CALIBRATION (from their own past corrections): ${userCalibration}`);
    }
    lines.push(`\nCapture:\n${text}`);
    return lines.join("\n");
  },
};
