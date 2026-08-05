import { config } from "../config.js";
import { query, queryOne, toVector } from "../db/pool.js";
import { embed } from "../llm/embeddings.js";
import { searchTweets, type XTweet } from "../capture/imports/twitterapi-io.js";
import { breakoutRatio } from "./viral-heuristics.js";

/**
 * The deterministic candidate gate for the daily viral case study (§3h). CODE
 * decides which single tweet is surfaced; the model never selects. Order:
 *
 *   niche-seeded search (min_faves proxy, recency window) → view-count BAND
 *   filter (real viewCount, since twitterapi has no min_views operator) → dedup
 *   (tweet already sent, or author within cooldown) → niche relevance gate
 *   (pgvector vs the user's positions) → deterministic rank → exactly one.
 */

export interface ViralPick {
  tweet: XTweet;
  /** Cosine distance to the nearest active position (lower = more on-niche). */
  nicheDistance: number;
  /** The deterministic ranking score that won it the slot. */
  score: number;
}

/** OR the niche seed terms into one advanced_search query. */
function seedQuery(themes: string[]): string {
  const terms = themes
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t));
  return `(${terms.join(" OR ")}) -filter:replies lang:en min_faves:${config.VIRAL_MIN_FAVES_PROXY}`;
}

/**
 * Rank score, all sub-scores normalized 0..1, deterministic:
 *  - relevance (1 − niche distance): most important - it must be something the
 *    user would plausibly see on their own feed, not just generically viral.
 *  - breakout (log of views ÷ followers): escaped-its-reach signal.
 *  - reach (log of views within the band): bigger within band is a better example.
 */
function rankScore(tweet: XTweet, nicheDistance: number): number {
  const relevance = Math.max(0, 1 - nicheDistance);
  const breakout = Math.min(1, Math.log10(Math.max(1, breakoutRatio(tweet.viewCount, tweet.authorFollowers)) + 1) / 2); // ~100x breakout saturates
  const reach = Math.min(1, Math.log10(Math.max(1, tweet.viewCount)) / 7); // 10M views saturates
  return Math.round((relevance * 0.5 + breakout * 0.3 + reach * 0.2) * 1000) / 1000;
}

/**
 * The SHARED half of selection: search + view-count BAND filter. The niche seeds
 * are the same across the user base, so this runs ONCE per job run - not once
 * per user (that re-ran the identical paid twitterapi search per user, reset the
 * per-call rate pacing each time → self-inflicted 429s, and cost O(users) for
 * identical data). `handleViralBenchmark` fetches this once and passes the pool
 * to every user's `selectFromPool`.
 */
export async function fetchViralPool(themes: string[]): Promise<XTweet[]> {
  if (themes.length === 0) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - config.VIRAL_RECENCY_HOURS * 3600;

  let raw: XTweet[];
  try {
    raw = await searchTweets(seedQuery(themes), {
      queryType: "Latest",
      sinceTime: sinceSec,
      untilTime: nowSec,
      maxPages: config.TWITTERAPI_SEARCH_PAGE_CAP,
    });
  } catch (err) {
    console.error("viral: candidate search failed", err);
    return [];
  }

  // View-count BAND filter - the defining gate. No min_views search operator
  // exists, so this is where the impression band is actually enforced, on the
  // real viewCount the search returned.
  const banded = new Map<string, XTweet>();
  for (const t of raw) {
    if (t.isReply || !t.url || !t.authorHandle) continue;
    if (t.viewCount < config.VIRAL_VIEW_MIN || t.viewCount > config.VIRAL_VIEW_MAX) continue;
    if (t.text.trim().length < 15) continue;
    if (!banded.has(t.id)) banded.set(t.id, t);
  }
  return [...banded.values()].sort((a, b) => b.viewCount - a.viewCount).slice(0, 20);
}

/**
 * The PER-USER half: dedup against this user's ledger, niche-gate against their
 * positions, deterministically rank, take one. Reads no provider - works off the
 * shared pool from `fetchViralPool`.
 */
export async function selectFromPool(userId: string, pool: XTweet[]): Promise<ViralPick | null> {
  if (pool.length === 0) return null;

  // Dedup: never the same tweet twice, and hold off a repeat-offender author for
  // the cooldown window. One query covers both.
  const sent = await query<{ tweet_id: string; author_handle: string; in_window: boolean }>(
    `SELECT tweet_id, author_handle,
            (sent_at > now() - ($2 || ' days')::interval) AS in_window
     FROM viral_benchmarks
     WHERE user_id = $1
       AND (sent_at > now() - ($2 || ' days')::interval OR tweet_id = ANY($3))`,
    [userId, String(config.VIRAL_AUTHOR_COOLDOWN_DAYS), pool.map((t) => t.id)],
  );
  // Never resend the same tweet (any age). But only COOL an author when a send
  // actually falls inside the window - an old tweet resurfacing in the candidate
  // pool (matched by tweet_id, not by window) must not re-block its author past
  // the cooldown, which was silently over-blocking authors indefinitely.
  const sentTweetIds = new Set(sent.map((r) => r.tweet_id));
  const cooledAuthors = new Set(sent.filter((r) => r.in_window).map((r) => r.author_handle.toLowerCase()));
  const fresh = pool.filter((t) => !sentTweetIds.has(t.id) && !cooledAuthors.has(t.authorHandle.toLowerCase()));
  if (fresh.length === 0) return null;

  // Niche relevance gate (pgvector vs the user's positions). Batch-embed the
  // survivors once, then a cheap distance query per candidate.
  let embeddings: number[][];
  try {
    embeddings = await embed(fresh.map((t) => t.text.slice(0, 500)), null);
  } catch (err) {
    console.error("viral: candidate embedding failed", err);
    return null;
  }

  let best: ViralPick | null = null;
  for (let i = 0; i < fresh.length; i++) {
    const tweet = fresh[i]!;
    const vec = embeddings[i];
    if (!vec) continue;
    const row = await queryOne<{ dist: number | null }>(
      `SELECT min(embedding <=> $2::vector) AS dist FROM positions
       WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL`,
      [userId, toVector(vec)],
    );
    const dist = row?.dist;
    if (dist === null || dist === undefined || dist >= config.NICHE_THRESHOLD) continue;
    const score = rankScore(tweet, dist);
    if (!best || score > best.score) best = { tweet, nicheDistance: dist, score };
  }
  return best;
}

/** Convenience for one-off/manual fires: fetch the pool, then select. The
 *  scheduled job uses fetchViralPool + selectFromPool directly to share the pool. */
export async function selectViralCandidate(userId: string, themes: string[]): Promise<ViralPick | null> {
  return selectFromPool(userId, await fetchViralPool(themes));
}
