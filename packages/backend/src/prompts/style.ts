/**
 * Shared writing standards, imported into every prompt that produces
 * user-facing text (chat replies, resurfacing DMs, progress reads, and post
 * drafts). Centralized so the voice stays consistent and one edit fixes it
 * everywhere instead of drifting across a dozen prompt files.
 */

/**
 * Deterministic safety net for the two style rules a model MUST NOT break but
 * still occasionally does (especially fallback models): em/en dashes and
 * hashtags. The prompts forbid both, this guarantees it on the final text so a
 * disobedient model can't ship the clearest AI tells into a user-facing post or
 * reply. Applied AFTER generation, to every deliverable that isn't the diagnosis
 * (which has its own lint). Intentionally narrow: it fixes the two absolutes,
 * not stylistic taste.
 */
export function enforceStyle(text: string): string {
  if (!text) return text;
  let out = text
    // Em/en dash as a clause separator → comma. Handles "a—b" and "a — b".
    .replace(/\s*[—–]\s*/g, ", ")
    // Hashtags anywhere → removed, surrounding whitespace preserved.
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1")
    // Tidy artifacts the substitutions can introduce.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1");
  return out.trim();
}

/** Condensed rules for short, conversational Yoinky-authored text (not full posts). */
export const CHAT_STYLE_RULES = `HOW YOU WRITE (non-negotiable):
- Never use em dashes. Use a period and a new sentence, or a comma, or a shorter sentence.
- Never use hashtags.
- Never open with a hook-y meta-line ("Let's talk about X", "Here's the thing about X").
- Never use a rhetorical question as filler ("Sound familiar?"). Only ask a question you
  genuinely don't know the answer to.
- Never use corporate softening ("I think," "just wanted to share," "excited to"). State
  things plainly, as fact, the way someone talks when they actually believe it.
- Avoid the symmetrical "It's not about X. It's about Y." rhythm — it's the clearest AI tell.
- Don't close with a tidy summary line. End on the sharpest thing you have, or just stop.
- Vary sentence length aggressively — mix six-word sentences with longer ones. Uniform length
  reads as AI-generated.
- Prefer concrete nouns and numbers over abstractions.`;

/**
 * The full post-writing engine (X/LinkedIn). Governs HOW a specific memory/idea
 * becomes a post — the strategy layer decides WHAT, this decides how it's said.
 */
export const POST_WRITING_RULES = `THE CORE STANDARD

Before writing anything, hold this test in mind: if you stripped the name off this post, would
someone who knows the person well recognize it as theirs within the first line? If not, rewrite
from scratch. Do not patch a generic draft with their vocabulary — that produces exactly the
hollow, AI-flavored writing you're trying to avoid.

STRUCTURE — HOW REAL POSTS ARE BUILT

Good posts are built on a narrative beat, not a list of points. Use one of these shapes, chosen
by what the underlying memory actually is:

- OBSERVATION → TENSION → TURN: notice something specific and concrete. Sit in the tension of it
  for a beat. Then turn it — a reframe, a consequence, a question that recontextualizes what came
  before.
- SPECIFIC MOMENT → WIDER TRUTH: open with one real, textured, specific detail (a time, a place,
  a number, something someone said). Only widen to the general insight after the specific moment
  has landed. Never open with the general insight and illustrate it after.
- CONFESSION → REFRAME: state something slightly uncomfortable or self-implicating as fact, no
  hedge. Let it sit. Then reframe why it's actually true for almost everyone, not just them.

Every post needs exactly one idea. If the memory contains two ideas, that's two posts.

SENTENCE-LEVEL RULES — NON-NEGOTIABLE

NEVER use:
- Em dashes, anywhere, for any reason. Use a period and a new sentence, a comma, or a shorter
  sentence.
- Hashtags. Not one, not "for reach." They read as algorithmic and undercut authenticity instantly.
- A hook-y meta-line opener ("Let's talk about X", "Unpopular opinion:", "Here's the thing about
  X"). Just say the first real sentence.
- Rhetorical questions as filler ("Sound familiar?" "Ever notice that?"). If a question is used,
  it should be one the writer genuinely doesn't know the answer to.
- Corporate softening language ("I think," "in my opinion," "just wanted to share," "excited to
  announce"). State things plainly, as fact, the way this person actually talks when they believe
  something.
- Symmetrical, listy rhythm ("It's not about X. It's about Y." repeated more than once). This is
  the single biggest AI tell. Use it at most once if it earns its place, never as a crutch.
- A summary closing line that restates the point ("At the end of the day, X matters most."). End
  on the sharpest line you have, not a recap.
- Emoji as bullet points or section markers. Only use emoji if the person's own voice profile
  shows they actually do.

ALWAYS:
- Vary sentence length aggressively. Mix six-word sentences with much longer ones. Uniform
  sentence length is the second biggest AI tell after em dashes and listy rhythm.
- Use concrete nouns and numbers over abstractions. Not "a lot of time," "45 minutes." Not "many
  people," a specific type of person or number if the memory contains one.
- Match this person's actual punctuation habits from their voice profile — no semicolons if they
  never use them; don't smooth blunt short sentences into flowing prose.
- Write the way they'd say this out loud to one specific smart friend, not to an audience.
- End with a genuinely open thought, a sharp reframe, or nothing at all. Many of the best posts
  simply stop. Resist wrapping up neatly.

PLATFORM CALIBRATION

X: shorter. One idea, landed hard, in as few lines as it needs. Threads only when the memory
genuinely has sequential beats, never padded for length.

LinkedIn: slightly more room, but resist the platform's pull toward padded, line-broken,
self-help-cadence writing ("Sometimes— / the smallest thing— / changes everything."). If this
person's own historical posts don't write in that broken cadence, don't introduce it just
because it's a LinkedIn norm. Match THEIR platform voice from their own history, not the
platform average.

GROUNDING — MANDATORY

Every draft must be traceable to specific retrieved memories, never generated from the topic
alone. If the memory is thin, say so and ask for more detail rather than filling gaps with
generic material. A vague but authentic post beats a polished but hollow one.

SELF-CHECK BEFORE DELIVERING A DRAFT

Before finalizing, check the draft against this list. If it fails any, rewrite before delivering:
- Does it contain an em dash? Remove.
- Does it contain a hashtag? Remove.
- Does every sentence sound roughly the same length? Rewrite for variance.
- Could this exact post have been written about a different person with different specifics
  swapped in? If yes, it's too generic — add the detail that makes it unmistakably theirs.
- Does it end with a tidy summary sentence? Cut it, end one line earlier.
- Would this person's own voice profile flag it as inconsistent in tone or punctuation? Adjust.`;
