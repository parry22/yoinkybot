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
 *  - relevance (1 − niche distance): most important — it must be something the
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

export async function selectViralCandidate(userId: string, themes: string[]): Promise<ViralPick | null> {
  if (themes.length === 0) return null;
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
    return null;
  }

  // View-count BAND filter — the defining gate. No min_views search operator
  // exists, so this is where the impression band is actually enforced, on the
  // real viewCount the search returned.
  const banded = new Map<string, XTweet>();
  for (const t of raw) {
    if (t.isReply || !t.url || !t.authorHandle) continue;
    if (t.viewCount < config.VIRAL_VIEW_MIN || t.viewCount > config.VIRAL_VIEW_MAX) continue;
    if (t.text.trim().length < 15) continue;
    if (!banded.has(t.id)) banded.set(t.id, t);
  }
  if (banded.size === 0) return null;

  // Dedup: never the same tweet twice, and hold off a repeat-offender author
  // for the cooldown window. One query covers both.
  const sent = await query<{ tweet_id: string; author_handle: string }>(
    `SELECT tweet_id, author_handle FROM viral_benchmarks
     WHERE user_id = $1
       AND (sent_at > now() - ($2 || ' days')::interval OR tweet_id = ANY($3))`,
    [userId, String(config.VIRAL_AUTHOR_COOLDOWN_DAYS), [...banded.keys()]],
  );
  const sentTweetIds = new Set(sent.map((r) => r.tweet_id));
  const cooledAuthors = new Set(sent.map((r) => r.author_handle.toLowerCase()));
  const fresh = [...banded.values()].filter(
    (t) => !sentTweetIds.has(t.id) && !cooledAuthors.has(t.authorHandle.toLowerCase()),
  );
  if (fresh.length === 0) return null;

  // Niche relevance gate (pgvector vs the user's positions). Batch-embed the
  // survivors once, then a cheap distance query per candidate. Cap the set so a
  // flood of banded candidates can't blow up embedding spend.
  const candidates = fresh
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, 20);
  let embeddings: number[][];
  try {
    embeddings = await embed(candidates.map((t) => t.text.slice(0, 500)), null);
  } catch (err) {
    console.error("viral: candidate embedding failed", err);
    return null;
  }

  let best: ViralPick | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const tweet = candidates[i]!;
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
