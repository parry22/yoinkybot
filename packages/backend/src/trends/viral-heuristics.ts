/**
 * Deterministic "why it blew up" facts for a single high-impression tweet —
 * pure functions, no I/O, no model. Same doctrine as engagement/heuristics.ts:
 * the composition agent narrates THESE numbers; it never invents "hooks and
 * algorithm" folklore. Every field here is computed from the tweet's real
 * counts, never guessed.
 */

export interface ViralTweetStats {
  viewCount: number;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  bookmarkCount: number;
  authorFollowers: number;
  postedAtMs: number;
  nowMs: number;
  hasMedia: boolean;
  text: string;
}

export type Opener = "question" | "number" | "bold_claim" | "plain";

export interface ViralHeuristics {
  view_count: number;
  /** views ÷ author followers — the single best "escaped its normal reach" signal. */
  breakout_ratio: number;
  /** Engagement rate per 1,000 views (like/rt/reply/bookmark). Bookmarks are the
   *  "save for later" signal that often precedes sustained reach. */
  like_rate_per_1k: number;
  retweet_rate_per_1k: number;
  reply_rate_per_1k: number;
  bookmark_rate_per_1k: number;
  /** Share of engagement that is amplification (rt+quote) vs passive (likes). */
  amplification_share: number;
  /** Views per hour since posting — raw velocity. */
  views_per_hour: number;
  hours_since_post: number;
  has_media: boolean;
  char_length: number;
  length_bucket: "one_liner" | "short" | "medium" | "long";
  opener: Opener;
}

function per1k(count: number, views: number): number {
  if (views <= 0) return 0;
  return Math.round((count / views) * 1000 * 100) / 100;
}

export function breakoutRatio(views: number, followers: number): number {
  if (followers <= 0) return 0;
  return Math.round((views / followers) * 100) / 100;
}

export function classifyOpener(text: string): Opener {
  const t = text.trim();
  if (/^[^\n]{0,80}\?/.test(t)) return "question";
  if (/^\s*(?:\d|[$£€]\d)/.test(t)) return "number";
  // A short, punchy declarative first line (no hedging) reads as a bold claim.
  const firstLine = t.split("\n")[0] ?? "";
  if (firstLine.length <= 100 && /^[A-Z0-9"']/.test(firstLine) && !/^(i think|maybe|perhaps|imo|in my)/i.test(firstLine)) {
    return "bold_claim";
  }
  return "plain";
}

function lengthBucket(n: number): ViralHeuristics["length_bucket"] {
  if (n <= 80) return "one_liner";
  if (n <= 160) return "short";
  if (n <= 240) return "medium";
  return "long";
}

export function computeViralHeuristics(s: ViralTweetStats): ViralHeuristics {
  const hours = Math.max(0.1, (s.nowMs - s.postedAtMs) / 3_600_000);
  const amplify = s.retweetCount + s.quoteCount;
  const passive = s.likeCount;
  const ampDenom = amplify + passive;
  return {
    view_count: s.viewCount,
    breakout_ratio: breakoutRatio(s.viewCount, s.authorFollowers),
    like_rate_per_1k: per1k(s.likeCount, s.viewCount),
    retweet_rate_per_1k: per1k(s.retweetCount, s.viewCount),
    reply_rate_per_1k: per1k(s.replyCount, s.viewCount),
    bookmark_rate_per_1k: per1k(s.bookmarkCount, s.viewCount),
    amplification_share: ampDenom > 0 ? Math.round((amplify / ampDenom) * 100) / 100 : 0,
    views_per_hour: Math.round(s.viewCount / hours),
    hours_since_post: Math.round(hours * 10) / 10,
    has_media: s.hasMedia,
    char_length: s.text.length,
    length_bucket: lengthBucket(s.text.length),
    opener: classifyOpener(s.text),
  };
}
