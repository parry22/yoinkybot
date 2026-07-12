import { config } from "../../config.js";
import { searchTweets, type XTweet } from "../../capture/imports/twitterapi-io.js";
import { buzzScore, distinctAuthorCount, totalEngagement, velocity, type BuzzTweet } from "../scoring.js";

/**
 * Volume verification for trend candidates. Trend actors (Apify) give a name
 * and a rough bucket, not real engagement data — this module asks twitterapi.io
 * advanced_search what is ACTUALLY happening around a phrase, in two passes:
 *
 *   Pass 1 (Top, min_faves-gated, replies excluded): engagement + top tweets.
 *   Pass 2 (Latest, replies excluded): recency/velocity over the window.
 *
 * Pagination is capped (TWITTERAPI_SEARCH_PAGE_CAP) — $0.00015/tweet returned
 * is cheap per topic but not free at scale. All scoring is deterministic
 * (trends/scoring.ts); nothing here calls a model.
 */

/** Only tweets with at least this many likes count toward the Top pass. */
const MIN_FAVES = 20;
/** How far back the verification window reaches. */
const WINDOW_HOURS = 24;

export interface VolumeVerification {
  topic: string;
  buzz: number;
  signals: {
    distinctAuthors: number;
    totalEngagement: number;
    velocity: number;
    inTrendList: boolean;
  };
  /** Pass-1 tweets, strongest engagement first — the agent's get_top_tweets pool. */
  topTweets: XTweet[];
}

export function twitterapiConfigured(): boolean {
  return !!config.TWITTERAPI_IO_KEY;
}

function toBuzzTweet(t: XTweet): BuzzTweet {
  return {
    authorHandle: t.authorHandle,
    likeCount: t.likeCount,
    retweetCount: t.retweetCount,
    replyCount: t.replyCount,
    createdAtMs: t.createdAt.getTime(),
  };
}

export async function verifyTrendVolume(topic: string, inTrendList: boolean): Promise<VolumeVerification> {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - WINDOW_HOURS * 3600;
  const phrase = `"${topic.replace(/"/g, "")}"`;

  // Both passes use queryType "Latest": twitterapi's "Top" returns nothing for
  // windowed queries (verified live 2026-07-12), which silently zeroed the
  // engagement pass. Pass 1 is the engagement pool (min_faves-gated), Pass 2 is
  // the unfiltered recency stream for velocity.
  const top = await searchTweets(`${phrase} min_faves:${MIN_FAVES} -filter:replies lang:en`, {
    queryType: "Latest",
    sinceTime: sinceSec,
    untilTime: nowSec,
    maxPages: config.TWITTERAPI_SEARCH_PAGE_CAP,
  });
  const latest = await searchTweets(`${phrase} -filter:replies lang:en`, {
    queryType: "Latest",
    sinceTime: sinceSec,
    untilTime: nowSec,
    maxPages: config.TWITTERAPI_SEARCH_PAGE_CAP,
  });

  const byId = new Map<string, XTweet>();
  for (const t of [...top, ...latest]) byId.set(t.id, t);
  const unionTweets = [...byId.values()];
  const union = unionTweets.map(toBuzzTweet);

  const signals = {
    distinctAuthors: distinctAuthorCount(union),
    // Engagement over the union — not just the min_faves pass — so the signal is
    // real even when the two passes overlap heavily.
    totalEngagement: totalEngagement(union),
    velocity: velocity(latest.map(toBuzzTweet), sinceSec * 1000, nowSec * 1000),
    inTrendList,
  };
  // The source pool is the UNION of both passes, strongest engagement first —
  // NOT just the "Top" pass. Live, a term can clear the buzz gate on authors
  // seen in the "Latest" pass while "Top" (min_faves-gated) returns nothing,
  // which used to leave the agent with zero tweets to cite as the source post.
  const engagement = (t: XTweet) => t.likeCount + t.retweetCount + t.replyCount;
  return {
    topic,
    buzz: buzzScore(signals),
    signals,
    topTweets: unionTweets.sort((a, b) => engagement(b) - engagement(a)),
  };
}
