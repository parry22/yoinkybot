/**
 * Deterministic voice measurement - pure functions, no LLM. The diagnosis spec
 * demands "sample the sentence length distribution", "describe what's actually
 * there", "compare early against recent". A model can't reliably count; this
 * counts, and the model interprets the numbers.
 */

export interface VoiceDrift {
  earlyPeriod: string; // "2025-01..2025-04"
  recentPeriod: string;
  earlyMeanSentenceLen: number;
  recentMeanSentenceLen: number;
  earlyHedgesPerPost: number;
  recentHedgesPerPost: number;
  earlyExclaimPerPost: number;
  recentExclaimPerPost: number;
}

export interface VoiceStats {
  postCount: number;
  meanSentenceLen: number; // words per sentence
  sentenceLenCv: number; // coefficient of variation; low = flat/uniform (self-editing tell)
  shortSentencePct: number; // < 8 words
  longSentencePct: number; // > 25 words
  perPost: {
    emDashes: number;
    semicolons: number;
    exclamations: number;
    questions: number;
    hashtags: number;
  };
  lowercaseStartPct: number; // posts that open lowercase
  hedgesPerPost: number;
  drift: VoiceDrift | null; // null when too little history to split
}

const HEDGES = [
  "i think",
  "i guess",
  "maybe",
  "perhaps",
  "probably",
  "might be",
  "it seems",
  "in my opinion",
  "imo",
  "just my",
  "not sure but",
];

interface Post {
  content: string;
  created_at: string;
}

function sentences(text: string): string[] {
  return text
    .split(/[.!?]+[\s"')\]]*/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length > 1);
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function hedges(text: string): number {
  const lower = text.toLowerCase();
  return HEDGES.reduce((n, h) => n + (lower.includes(h) ? 1 : 0), 0);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Needs a handful of posts to say anything; returns null below that. */
export function computeVoiceStats(posts: Post[]): VoiceStats | null {
  if (posts.length < 5) return null;

  const allSentences = posts.flatMap((p) => sentences(p.content));
  const lens = allSentences.map(words);
  const m = mean(lens);
  const sd = Math.sqrt(mean(lens.map((l) => (l - m) ** 2)));

  const totalPosts = posts.length;
  const stat = (re: RegExp) => posts.reduce((n, p) => n + count(p.content, re), 0) / totalPosts;

  let drift: VoiceDrift | null = null;
  if (posts.length >= 12) {
    const byDate = [...posts].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const third = Math.floor(byDate.length / 3);
    const early = byDate.slice(0, third);
    const recent = byDate.slice(-third);
    const meanLen = (ps: Post[]) => mean(ps.flatMap((p) => sentences(p.content)).map(words));
    const perPost = (ps: Post[], fn: (t: string) => number) => mean(ps.map((p) => fn(p.content)));
    drift = {
      earlyPeriod: `${monthOf(early[0]!.created_at)}..${monthOf(early[early.length - 1]!.created_at)}`,
      recentPeriod: `${monthOf(recent[0]!.created_at)}..${monthOf(recent[recent.length - 1]!.created_at)}`,
      earlyMeanSentenceLen: round(meanLen(early)),
      recentMeanSentenceLen: round(meanLen(recent)),
      earlyHedgesPerPost: round(perPost(early, hedges)),
      recentHedgesPerPost: round(perPost(recent, hedges)),
      earlyExclaimPerPost: round(perPost(early, (t) => count(t, /!/g))),
      recentExclaimPerPost: round(perPost(recent, (t) => count(t, /!/g))),
    };
  }

  return {
    postCount: totalPosts,
    meanSentenceLen: round(m),
    sentenceLenCv: round(m > 0 ? sd / m : 0),
    shortSentencePct: round((100 * lens.filter((l) => l < 8).length) / Math.max(1, lens.length)),
    longSentencePct: round((100 * lens.filter((l) => l > 25).length) / Math.max(1, lens.length)),
    perPost: {
      emDashes: round(stat(/-/g)),
      semicolons: round(stat(/;/g)),
      exclamations: round(stat(/!/g)),
      questions: round(stat(/\?/g)),
      hashtags: round(stat(/(^|\s)#\w/g)),
    },
    lowercaseStartPct: round((100 * posts.filter((p) => /^[a-z]/.test(p.content.trim())).length) / totalPosts),
    hedgesPerPost: round(mean(posts.map((p) => hedges(p.content)))),
    drift,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Render for the diagnosis prompt's COMPUTED EVIDENCE block. */
export function formatVoiceStats(v: VoiceStats): string {
  const lines = [
    `${v.postCount} posts measured. Mean sentence length ${v.meanSentenceLen} words, variation coefficient ${v.sentenceLenCv} (under 0.45 reads flat/uniform, over 0.65 varied and alive).`,
    `${v.shortSentencePct}% short sentences (<8 words), ${v.longSentencePct}% long (>25).`,
    `Per post: ${v.perPost.emDashes} em dashes, ${v.perPost.semicolons} semicolons, ${v.perPost.exclamations} exclamations, ${v.perPost.questions} question marks, ${v.perPost.hashtags} hashtags.`,
    `${v.lowercaseStartPct}% of posts open lowercase. Hedging phrases ${v.hedgesPerPost} per post.`,
  ];
  if (v.drift) {
    const d = v.drift;
    lines.push(
      `Early (${d.earlyPeriod}) vs recent (${d.recentPeriod}): sentence length ${d.earlyMeanSentenceLen} → ${d.recentMeanSentenceLen} words, hedges/post ${d.earlyHedgesPerPost} → ${d.recentHedgesPerPost}, exclamations/post ${d.earlyExclaimPerPost} → ${d.recentExclaimPerPost}.`,
    );
  } else {
    lines.push("Not enough dated history to measure early-vs-recent drift.");
  }
  return lines.join("\n");
}
