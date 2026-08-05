import type { Prompt } from "./types.js";
import { LINKEDIN_WRITING_RULES, POST_WRITING_RULES, REACH_PRINCIPLES } from "./style.js";
import type { DraftEvidence } from "../drafting/evidence.js";

/**
 * Drafting, v2: same writing doctrine as v1, plus EVIDENCE. v1 was stylistically
 * well-specified and empirically blind - it applied universal reach rules to every
 * user identically because it had no idea which of *this* person's posts ever
 * landed, what shape they took, or what they were trying to do.
 *
 * v2 adds four measured blocks (drafting/evidence.ts): their own engagement
 * baseline, their real top posts as exemplars with numbers, the shapes that
 * out/under-perform their own median, and which INTENT lands (the `motive`
 * column, previously written by the classifier and read by nothing). It also
 * labels each retrieved memory with whether it came from a post they actually
 * PUBLISHED and how that post did.
 *
 * The load-bearing instruction is the reconciliation rule: when their measured
 * results contradict the universal doctrine, THEIR DATA WINS. Without that line
 * the model reads the evidence and still obeys the generic rules.
 *
 * NOTE on numbering: the previous file is `draft.v1.ts` but already carried
 * `version: 2` internally, so this one is `version: 3` to keep the counter
 * monotonic (that counter, not the filename, is what telemetry sees).
 */

export interface DraftV2Vars {
  request: string;
  platform: "x" | "linkedin";
  memories: Array<{
    id: string;
    content: string;
    kind: string;
    /** Set when this memory came from a post they actually published. */
    published?: boolean;
    engagement?: number | null;
    motive?: string | null;
    sincerity?: string | null;
  }>;
  voiceTraits: unknown;
  profileSummary?: string;
  offLimits?: string[];
  currentContext?: Array<{ topic: string; summary: string }>;
  /** Measured performance evidence for THIS user. */
  evidence: DraftEvidence;
}

const signed = (n: number): string => (n >= 0 ? `+${n}%` : `${n}%`);

/** Their real posts, as labelled exemplars with the numbers attached. */
function renderTopPosts(e: DraftEvidence): string {
  if (e.topPosts.length === 0) return "";
  const lines = e.topPosts.map((p) => {
    const tags = [
      p.ratio ? `${p.ratio}x your median` : null,
      `${p.engagement} engagements`,
      p.opener !== "plain" ? `opens with a ${p.opener.replace("_", " ")}` : "plain open",
      `${p.chars} chars`,
      p.sincerity ? `register: ${p.sincerity}` : null,
      p.motive ? `intent: ${p.motive}` : null,
      `${p.daysAgo}d ago`,
    ]
      .filter(Boolean)
      .join(" · ");
    return `- [${tags}]\n  "${p.text}"`;
  });
  return (
    `YOUR POSTS THAT ACTUALLY LANDED (their real text - this is what "sounds like them at their best" ` +
    `looks like in practice, and the numbers are measured against their own median of ` +
    `${e.baselineEngagement} engagements across ${e.postsConsidered} posts):\n${lines.join("\n")}\n\n`
  );
}

function renderQuietPosts(e: DraftEvidence): string {
  if (e.quietPosts.length === 0) return "";
  const lines = e.quietPosts.map((p) => `- [${p.engagement} engagements · ${p.chars} chars] "${p.text}"`);
  return (
    `THEIR QUIETEST POSTS (counter-examples - do NOT reproduce whatever these are doing):\n` +
    `${lines.join("\n")}\n\n`
  );
}

function renderShapeLift(e: DraftEvidence): string {
  if (e.shapeLift.length === 0) return "";
  const lines = e.shapeLift.map((s) => `- ${s.label}: ${signed(s.liftPct)} vs their median (${s.posts} posts)`);
  return `WHICH SHAPE OF POST WORKS FOR THIS PERSON (measured, not general advice):\n${lines.join("\n")}\n\n`;
}

function renderMotiveLift(e: DraftEvidence): string {
  if (e.motiveLift.length === 0) return "";
  const lines = e.motiveLift.map((m) => `- ${m.motive}: ${signed(m.liftPct)} vs their median (${m.posts} posts)`);
  return `WHICH INTENT WORKS FOR THIS PERSON (what the post was trying to do):\n${lines.join("\n")}\n\n`;
}

function renderMemories(v: DraftV2Vars): string {
  return v.memories
    .map((m) => {
      const label = m.published
        ? `PUBLISHED POST${m.engagement != null ? `, ${m.engagement} engagements` : ""}${
            m.motive ? `, intent: ${m.motive}` : ""
          }`
        : "private thinking, never posted";
      return `[${m.id}] (${m.kind} - ${label}) ${m.content}`;
    })
    .join("\n\n");
}

export const draftPostV2: Prompt<DraftV2Vars> = {
  id: "draft",
  version: 3,
  tier: "frontier",
  system: `You are Yoinky's writing engine. Turn the retrieved memories into a post that sounds
like it came from this person's own head at their sharpest moment, not from an AI. The memories
are the only allowed source of substance - you may sharpen and arrange, but every idea in the
draft must trace to a provided memory. If the memories cannot support the request, say so instead
of inventing.

Use the voice profile strictly: its vocabulary, rhythm, tics, and especially its anti_patterns
(things that would feel fake for this person).

HONOR THEIR STATED PROFILE (below, when present): stay on their content pillars and niche, match
their stated formality and tone. HARD BOUNDARY: never write about an OFF-LIMITS topic. If the
request targets one, decline in the note and return an empty draft - a well-written post that
crosses their stated line is a failure, not a draft.

USE THE EVIDENCE, AND LET IT OVERRULE THE GENERAL RULES.
The context below may include this person's own measured results: their engagement baseline, the
real text of posts that beat it, their quietest posts, which SHAPE of post over/under-performs for
them, and which INTENT lands. Treat all of it as the strongest available signal:
- Their landed posts are the truest specification of their voice - closer than any profile JSON.
  Study how those posts open, how long they run, how they end, how much they hedge.
- THE RECONCILIATION RULE: where their measured results contradict the universal reach doctrine
  below, THEIR DATA WINS, and say so in the note. If "short & punchy" is -35% for them, do not
  write short and punchy just because brevity is generally good advice. If their questions
  underperform, do not end on a question. General doctrine is the prior; their numbers are the
  evidence.
- Do NOT copy a past post's wording or rewrite an old post. Match its MECHANICS, not its content.
- Never mention metrics, engagement, or "what performs" inside the draft itself. The evidence
  shapes how you write; it is never the subject.
- When there is no evidence block, fall back to the universal doctrine below and don't speculate
  about what works for them.

A memory marked PUBLISHED POST is something they already said in public - do not restate it as if
it were new; build past it. A memory marked "private thinking" has never been posted, which makes
it the most valuable raw material you have.

${POST_WRITING_RULES}

${REACH_PRINCIPLES}

MEDIA: a post carried by a native image, a simple diagram, a real screenshot, or a poll travels
further than text alone. Suggest one concrete, specific visual grounded in the post's actual
substance - name the thing to show ("a screenshot of the failing test output", "a two-box before/
after diagram"), never a generic "add an image". If the post is genuinely stronger as pure text
(an aphorism, a confession), return an empty media_suggestion rather than forcing one.

Respond with ONLY valid JSON:
{"draft":"...","source_memory_ids":["..."],"media_suggestion":"one concrete visual to pair with the post, or empty string","note":"anything the author should know (or empty string)"}
If the memories are insufficient, or the request crosses an off-limits topic: {"draft":"","source_memory_ids":[],"media_suggestion":"","note":"why"}`,
  render: (v) =>
    `Request: ${v.request}\nPlatform: ${v.platform}\n\n` +
    (v.platform === "linkedin" ? `${LINKEDIN_WRITING_RULES}\n\n` : "") +
    (v.profileSummary ? `THEIR STATED PROFILE:\n${v.profileSummary}\n\n` : "") +
    (v.offLimits?.length
      ? `OFF-LIMITS TOPICS (never draft on these):\n${v.offLimits.map((t) => `- ${t}`).join("\n")}\n\n`
      : "") +
    renderTopPosts(v.evidence) +
    renderShapeLift(v.evidence) +
    renderMotiveLift(v.evidence) +
    renderQuietPosts(v.evidence) +
    (v.currentContext?.length
      ? `LIVE ON X RIGHT NOW (near this topic - use ONLY if it genuinely sharpens the post; a natural nod to the live conversation reads current, a forced reference reads like engagement bait; substance must still come from the memories):\n${v.currentContext.map((c) => `- ${c.topic}: ${c.summary}`).join("\n")}\n\n`
      : "") +
    `Voice profile:\n${JSON.stringify(v.voiceTraits, null, 2)}\n\n` +
    `Retrieved memories:\n${renderMemories(v)}`,
};
