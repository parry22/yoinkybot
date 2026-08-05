/**
 * Deterministic buzz scoring for trend candidates - pure functions, no I/O,
 * no model. A single LLM call can't tell real buzz from noise and can't verify
 * volume itself, so whether a trend is REAL is computed here from verified
 * tweet data (twitterapi.io advanced_search) and gated in code before any
 * composition call happens. The agent only ever writes about a candidate that
 * already cleared this bar.
 */

export interface BuzzTweet {
  authorHandle: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  createdAtMs: number;
}

/** Spec weights - components are normalized 0..1 before combining. */
const W_AUTHORS = 0.35;
const W_ENGAGEMENT = 0.3;
const W_VELOCITY = 0.2;
const W_TREND_RANK = 0.15;

/**
 * Distinct authors matter more than raw tweet count - one account posting 50
 * times looks like a trend and isn't.
 */
export function distinctAuthorCount(tweets: BuzzTweet[]): number {
  return new Set(tweets.map((t) => t.authorHandle.toLowerCase()).filter(Boolean)).size;
}

export function totalEngagement(tweets: BuzzTweet[]): number {
  return tweets.reduce((sum, t) => sum + Math.max(0, t.likeCount) + Math.max(0, t.retweetCount) + Math.max(0, t.replyCount), 0);
}

/**
 * 2nd-half-window tweet count over 1st-half - >1 means accelerating. An empty
 * first half with activity in the second reads as max acceleration; a dead
 * window reads as 0.
 */
export function velocity(tweets: BuzzTweet[], windowStartMs: number, windowEndMs: number): number {
  const mid = windowStartMs + (windowEndMs - windowStartMs) / 2;
  let first = 0;
  let second = 0;
  for (const t of tweets) {
    if (t.createdAtMs < windowStartMs || t.createdAtMs > windowEndMs) continue;
    if (t.createdAtMs < mid) first++;
    else second++;
  }
  if (first === 0) return second > 0 ? 2 : 0;
  return second / first;
}

export interface BuzzSignals {
  distinctAuthors: number;
  totalEngagement: number;
  /** velocity() output - 1.0 is steady, 2.0 saturates the component. */
  velocity: number;
  /** The topic also appears in the provider trend list (Apify). */
  inTrendList: boolean;
}

/** ~300 distinct authors and ~100k total engagement saturate their components. */
export function buzzScore(s: BuzzSignals): number {
  const authors01 = Math.min(1, Math.log10(Math.max(0, s.distinctAuthors) + 1) / 2.5);
  const engagement01 = Math.min(1, Math.log10(Math.max(0, s.totalEngagement) + 1) / 5);
  const velocity01 = Math.min(2, Math.max(0, s.velocity)) / 2;
  const raw =
    authors01 * W_AUTHORS + engagement01 * W_ENGAGEMENT + velocity01 * W_VELOCITY + (s.inTrendList ? W_TREND_RANK : 0);
  return Math.round(raw * 1000) / 1000;
}
