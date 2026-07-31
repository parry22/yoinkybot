import { config } from "../../config.js";
import { currentUserId } from "../../byok/context.js";
import { scraperKeyForUser } from "../../byok/keys.js";
import type { ImportedPost } from "./x.js";
import type { ProfilePull } from "./apify-profile.js";

const MAX_PAGES = 30; // hard safety cap regardless of maxPosts (API returns 20/page)
// Free tier is capped at 1 request/5s (verified live 2026-07-05: back-to-back
// pagination 429s immediately). Space requests out with margin above that.
const MIN_REQUEST_INTERVAL_MS = 5500;

interface RawTweet {
  id?: string;
  url?: string;
  text?: string;
  createdAt?: string;
  isReply?: boolean;
  retweetCount?: number;
  replyCount?: number;
  likeCount?: number;
  quoteCount?: number;
  viewCount?: number;
  bookmarkCount?: number;
  conversationId?: string;
  retweeted_tweet?: unknown;
  author?: { followers?: number; description?: string };
}

// Verified against a live call to /twitter/user/last_tweets on 2026-07-05: the
// tweets array is nested under `data`, and pagination fields sit at the TOP
// level — both differ from what the published docs page describes.
interface LastTweetsResponse {
  status?: string; // "success" | anything else on failure
  code?: number; // 0 = ok
  msg?: string;
  data?: { tweets?: RawTweet[] };
  has_next_page?: boolean;
  next_cursor?: string;
}

export class TwitterApiIoError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`twitterapi.io error ${status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Parse twitterapi.io's tweet shape into ImportedPost, carrying engagement +
 * thread context that the Apify actor doesn't expose. Pure function, no I/O.
 * Excludes replies and pure retweets — same "own original posts only" contract
 * as the other import paths, since positions/voice must be the person's words.
 */
export function parseTwitterApiIoTweets(
  tweets: RawTweet[],
): { posts: ImportedPost[]; bio?: string; followers?: number } {
  const posts: ImportedPost[] = [];
  let bio: string | undefined;
  let followers: number | undefined;

  for (const t of tweets) {
    bio ??= t.author?.description || undefined;
    followers ??= t.author?.followers ?? undefined;

    const text = (t.text ?? "").trim();
    if (!text || t.isReply || t.retweeted_tweet) continue;

    const date = t.createdAt ? new Date(t.createdAt) : new Date();
    posts.push({
      text,
      postedAt: Number.isNaN(date.getTime()) ? new Date() : date,
      url: t.url,
      engagement: {
        likeCount: t.likeCount,
        replyCount: t.replyCount,
        retweetCount: t.retweetCount,
        quoteCount: t.quoteCount,
        viewCount: t.viewCount,
        bookmarkCount: t.bookmarkCount,
        isReply: t.isReply ?? false,
        conversationId: t.conversationId,
      },
    });
  }
  return { posts, bio, followers };
}

/** Usable when EITHER we have a global key or the ambient user brought their own.
 *  The old guard checked only the global key, which would have refused a BYOK
 *  user on an instance that has no key of its own. */
async function assertTwitterApiUsable(): Promise<void> {
  if (config.TWITTERAPI_IO_KEY) return;
  const byok = await scraperKeyForUser(currentUserId());
  if (byok?.provider === "twitterapi") return;
  throw new Error("TWITTERAPI_IO_KEY not configured");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One page, retrying once on a 429 (honoring Retry-After if the API sends one).
 *
 *  EVERY twitterapi.io request in this file goes through here, which is why BYOK
 *  key resolution lives at this one point rather than in each of the five
 *  exported helpers — those only guard on config, they never send the header. */
async function fetchPage(url: URL): Promise<LastTweetsResponse> {
  // A lifetime user's own twitterapi.io key when we're inside their work
  // (byok/context.ts); ours otherwise. See lib/apify.ts for why the fallback
  // is deliberate rather than a failure.
  const byok = await scraperKeyForUser(currentUserId());
  const apiKey = byok?.provider === "twitterapi" ? byok.key : config.TWITTERAPI_IO_KEY;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { "X-API-Key": apiKey! },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : MIN_REQUEST_INTERVAL_MS);
      continue;
    }
    if (!res.ok) throw new TwitterApiIoError(res.status, await res.text());
    return (await res.json()) as LastTweetsResponse;
  }
  throw new TwitterApiIoError(429, "rate limited after retry");
}

/**
 * Paginate `/twitter/user/last_tweets` by cursor until maxPosts or the feed
 * runs out. The free tier allows 1 request/5s, so pages are spaced out. When
 * `sinceDays` is set, pagination stops early once a page reaches past the
 * cutoff with at least `minPosts` collected — the feed is newest-first, so
 * everything after that would be discarded by the recency window anyway.
 */
async function fetchTweets(
  userName: string,
  maxPosts: number,
  opts?: { sinceDays: number; minPosts: number },
): Promise<RawTweet[]> {
  await assertTwitterApiUsable();
  const cutoff = opts ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const all: RawTweet[] = [];
  let cursor = "";
  let lastRequestAt = 0;
  for (let page = 0; page < MAX_PAGES && all.length < maxPosts; page++) {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const url = new URL("/twitter/user/last_tweets", config.TWITTERAPI_IO_BASE_URL);
    url.searchParams.set("userName", userName);
    if (cursor) url.searchParams.set("cursor", cursor);
    lastRequestAt = Date.now();

    const body = await fetchPage(url);
    if (body.status !== "success") throw new Error(`twitterapi.io: ${body.msg ?? "unknown error"}`);

    const tweets = body.data?.tweets ?? [];
    all.push(...tweets);

    if (opts && all.length >= opts.minPosts) {
      const oldest = tweets[tweets.length - 1]?.createdAt;
      const oldestMs = oldest ? new Date(oldest).getTime() : NaN;
      if (Number.isFinite(oldestMs) && oldestMs < cutoff) break;
    }
    if (!body.has_next_page || !body.next_cursor) break;
    cursor = body.next_cursor;
  }

  // `last_tweets` cannot be trusted to return a user's history.
  //
  // Measured against a real account (4,115 tweets, public, not protected):
  // page 1 returned TWO tweets with `has_next_page: true`, and following that
  // cursor returned zero with `has_next_page: false`. The endpoint reported the
  // feed as exhausted after two posts. `advanced_search?query=from:<handle>`
  // returned twelve on its first page for the same account, still paginating,
  // and included a newer tweet `last_tweets` had never returned at all.
  //
  // The symptom was an analytics page that looked broken: two posts, both in the
  // current week, every earlier week empty. Nothing downstream was wrong — the
  // corpus really did contain two posts, because that is all the provider handed
  // over. So when the primary endpoint comes back implausibly thin, re-pull
  // through search and merge. Kept as a fallback rather than a replacement
  // because last_tweets is one request for accounts where it behaves, and
  // advanced_search costs a page walk.
  const wanted = Math.min(maxPosts, opts?.minPosts ?? MIN_HISTORY_BEFORE_SEARCH_FALLBACK);
  if (all.length < wanted) {
    console.warn(
      `[twitterapi] last_tweets returned only ${all.length} for @${userName} (wanted ${wanted}) — falling back to advanced_search`,
    );
    const viaSearch = await fetchOwnTweetsViaSearch(userName, maxPosts, opts);
    const seen = new Set(all.map((t) => t.id).filter(Boolean));
    for (const t of viaSearch) {
      if (t.id && seen.has(t.id)) continue;
      if (t.id) seen.add(t.id);
      all.push(t);
    }
    console.log(`[twitterapi] advanced_search fallback brought @${userName} to ${all.length} posts`);
  }

  return all.length > maxPosts ? all.slice(0, maxPosts) : all;
}

/** Below this many posts from `last_tweets`, assume it under-delivered and reach
 *  for search. Only used when the caller set no explicit `minPosts`. */
const MIN_HISTORY_BEFORE_SEARCH_FALLBACK = 20;

/**
 * A user's own recent tweets via `advanced_search?query=from:<handle>`, which
 * paginates honestly where `last_tweets` does not. Same shape and same early-stop
 * behaviour as `fetchTweets`, so it can be merged into that result directly.
 */
async function fetchOwnTweetsViaSearch(
  userName: string,
  maxPosts: number,
  opts?: { sinceDays: number; minPosts: number },
): Promise<RawTweet[]> {
  const cutoff = opts ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const all: RawTweet[] = [];
  let cursor = "";
  let lastRequestAt = 0;

  for (let page = 0; page < MAX_PAGES && all.length < maxPosts; page++) {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const url = new URL("/twitter/tweet/advanced_search", config.TWITTERAPI_IO_BASE_URL);
    // Deliberately NOT `-filter:replies`, though that looks like the obvious
    // optimisation. Measured on the same account: `from:handle` returned 12 on
    // page 1, `from:handle -filter:replies` returned 2. On a reply-heavy timeline
    // the server-side filter collapses each page to a handful of rows while still
    // consuming a page of the cursor walk, so it *starves* the search instead of
    // focusing it. Page through everything and let parseTwitterApiIoTweets drop
    // the replies and retweets, which it already does.
    url.searchParams.set("query", `from:${userName}`);
    url.searchParams.set("queryType", "Latest");
    if (cursor) url.searchParams.set("cursor", cursor);
    lastRequestAt = Date.now();

    const body = (await fetchPage(url)) as LastTweetsResponse & { tweets?: RawTweet[] };
    if (body.status && body.status !== "success") {
      throw new Error(`twitterapi.io advanced_search: ${body.msg ?? "unknown error"}`);
    }
    // advanced_search puts them at the top level; last_tweets nests under `data`.
    const tweets = body.tweets ?? body.data?.tweets ?? [];
    all.push(...tweets);

    if (opts && all.length >= opts.minPosts) {
      const oldest = tweets[tweets.length - 1]?.createdAt;
      const oldestMs = oldest ? new Date(oldest).getTime() : NaN;
      if (Number.isFinite(oldestMs) && oldestMs < cutoff) break;
    }
    if (!body.has_next_page || !body.next_cursor || tweets.length === 0) break;
    cursor = body.next_cursor;
  }
  return all;
}

/** Pull a user's public X history via twitterapi.io — richer than the Apify actor. */
/** Hard ceiling on how many of a user's own tweets we ever scrape in one pull. */
export const MAX_OWN_TWEETS = 100;

/** A timeline tweet (post OR reply) with its raw public metrics, for analytics. */
export interface TimelineTweet {
  id: string;
  url: string | null;
  text: string;
  createdAt: string;
  isReply: boolean;
  likeCount: number;
  replyCount: number;
  retweetCount: number;
  quoteCount: number;
  viewCount: number;
  bookmarkCount: number;
}

/**
 * Pull a user's recent timeline — posts AND replies — each with its public
 * counters (impressions/likes/replies/RT/quotes/bookmarks). Unlike the profile
 * pull (which drops replies for voice work), this keeps them so analytics can
 * show reply-level performance. Retweets are dropped (they carry the original's
 * metrics, not the user's). Capped at 100; rate-limited, so callers should treat
 * it as slow/on-demand.
 */
export async function pullXTimelineWithMetrics(
  handle: string,
  maxPosts = MAX_OWN_TWEETS,
): Promise<{ tweets: TimelineTweet[]; followers?: number }> {
  maxPosts = Math.min(maxPosts, MAX_OWN_TWEETS);
  const userName = handle.replace(/^@/, "").trim();
  const raw = await fetchTweets(userName, maxPosts);
  let followers: number | undefined;
  const tweets: TimelineTweet[] = [];
  for (const t of raw) {
    if (!t.text || t.retweeted_tweet) continue;
    followers ??= t.author?.followers;
    tweets.push({
      id: t.id ?? "",
      url: t.url ?? null,
      text: t.text,
      createdAt: t.createdAt ?? "",
      isReply: Boolean(t.isReply),
      likeCount: t.likeCount ?? 0,
      replyCount: t.replyCount ?? 0,
      retweetCount: t.retweetCount ?? 0,
      quoteCount: t.quoteCount ?? 0,
      viewCount: t.viewCount ?? 0,
      bookmarkCount: t.bookmarkCount ?? 0,
    });
  }
  return { tweets, followers };
}

export async function pullXProfileViaTwitterApiIo(
  handle: string,
  maxPosts = MAX_OWN_TWEETS,
  opts?: { sinceDays: number; minPosts: number },
): Promise<ProfilePull> {
  maxPosts = Math.min(maxPosts, MAX_OWN_TWEETS);
  const raw = await fetchTweets(handle, maxPosts, opts);
  const { posts, bio, followers } = parseTwitterApiIoTweets(raw);
  return { posts, meta: { bio, followers, handle } };
}

/** A tweet as consumed by the agent layers (thread context, volume checks). */
export interface XTweet {
  id: string;
  text: string;
  url: string | null;
  authorHandle: string;
  authorName: string;
  authorFollowers: number;
  /** Blue/verified affiliation — a reach signal for the breakout ratio. */
  authorVerified: boolean;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  /** Impressions. Populated by advanced_search (verified live 2026-07-13). */
  viewCount: number;
  bookmarkCount: number;
  /** Any image/video attached — a format signal for the viral breakdown. */
  hasMedia: boolean;
  isReply: boolean;
  conversationId: string | null;
  createdAt: Date;
}

function toXTweet(t: RawTweet): XTweet | null {
  const author = (t as {
    author?: { userName?: string; name?: string; followers?: number; isBlueVerified?: boolean; isVerified?: boolean };
  }).author;
  if (!t.id || !t.text?.trim()) return null;
  const date = t.createdAt ? new Date(t.createdAt) : new Date();
  const media = t as { extendedEntities?: { media?: unknown[] }; entities?: { media?: unknown[] } };
  const hasMedia = (media.extendedEntities?.media?.length ?? 0) > 0 || (media.entities?.media?.length ?? 0) > 0;
  return {
    id: t.id,
    text: t.text.trim(),
    url: t.url ?? null,
    authorHandle: author?.userName ?? "",
    authorName: author?.name ?? author?.userName ?? "",
    authorFollowers: author?.followers ?? 0,
    authorVerified: Boolean(author?.isBlueVerified || author?.isVerified),
    likeCount: t.likeCount ?? 0,
    retweetCount: t.retweetCount ?? 0,
    replyCount: t.replyCount ?? 0,
    quoteCount: t.quoteCount ?? 0,
    viewCount: t.viewCount ?? 0,
    bookmarkCount: t.bookmarkCount ?? 0,
    hasMedia,
    isReply: t.isReply ?? false,
    conversationId: t.conversationId ?? null,
    createdAt: Number.isNaN(date.getTime()) ? new Date() : date,
  };
}

/**
 * Fetch tweets by id via GET /twitter/tweets (`tweet_ids` param). Used for
 * live engagement counts + the conversation id of a mention before drafting.
 * VERIFY against a live call before first production run — this endpoint's
 * response nesting has not been confirmed live the way last_tweets/mentions
 * were; both observed shapes (top-level `tweets`, nested `data.tweets`) are
 * handled.
 */
export async function pullTweetsByIds(ids: string[]): Promise<XTweet[]> {
  await assertTwitterApiUsable();
  if (ids.length === 0) return [];
  const url = new URL("/twitter/tweets", config.TWITTERAPI_IO_BASE_URL);
  url.searchParams.set("tweet_ids", ids.join(","));
  const body = (await fetchPage(url)) as LastTweetsResponse & { tweets?: RawTweet[] };
  if (body.status && body.status !== "success") throw new Error(`twitterapi.io tweets: ${body.msg ?? "unknown error"}`);
  const tweets = body.tweets ?? body.data?.tweets ?? [];
  return tweets.map(toXTweet).filter((t): t is XTweet => t !== null);
}

export interface SearchOpts {
  /** "Top" ranks by engagement, "Latest" by recency. */
  queryType: "Top" | "Latest";
  /** Unix seconds — twitterapi.io takes since_time/until_time, NOT the
   *  `since:YYYY-MM-DD_...` form (explicitly unsupported there). */
  sinceTime?: number;
  untilTime?: number;
  /** Hard pagination cap; $0.00015/tweet returned is cheap per topic but not
   *  free at scale — never paginate unbounded. */
  maxPages: number;
}

/**
 * GET /twitter/tweet/advanced_search with cursor pagination and a hard page
 * cap. Query operators follow this API's naming: `min_faves:` /
 * `min_retweets:` / `min_replies:` (NOT min_likes/min_reposts from other
 * providers), `-filter:replies`, `conversation_id:`, `lang:`.
 */
export async function searchTweets(query: string, opts: SearchOpts): Promise<XTweet[]> {
  await assertTwitterApiUsable();
  const all: XTweet[] = [];
  let cursor = "";
  let lastRequestAt = 0;
  const q = [
    query,
    opts.sinceTime ? `since_time:${opts.sinceTime}` : "",
    opts.untilTime ? `until_time:${opts.untilTime}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  for (let page = 0; page < Math.max(1, opts.maxPages); page++) {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0 && page > 0) await sleep(wait);

    const url = new URL("/twitter/tweet/advanced_search", config.TWITTERAPI_IO_BASE_URL);
    url.searchParams.set("query", q);
    url.searchParams.set("queryType", opts.queryType);
    if (cursor) url.searchParams.set("cursor", cursor);
    lastRequestAt = Date.now();

    const body = (await fetchPage(url)) as LastTweetsResponse & { tweets?: RawTweet[] };
    if (body.status && body.status !== "success") {
      throw new Error(`twitterapi.io advanced_search: ${body.msg ?? "unknown error"}`);
    }
    const tweets = (body.tweets ?? body.data?.tweets ?? []).map(toXTweet).filter((t): t is XTweet => t !== null);
    all.push(...tweets);
    if (!body.has_next_page || !body.next_cursor || tweets.length === 0) break;
    cursor = body.next_cursor;
  }
  return all;
}

export interface XMention {
  externalId: string;
  url: string | null;
  authorHandle: string;
  authorReach: number;
  content: string;
  postedAt: Date;
}

/**
 * Public mentions of a handle (replies, quotes, @-mentions) via
 * /twitter/user/mentions. Verified live 2026-07-06: unlike last_tweets, this
 * endpoint returns `tweets` at the TOP level, newest first, 20/page — one page
 * per fetch cycle is enough, the ingest job runs several times a day.
 */
export async function pullXMentions(handle: string): Promise<XMention[]> {
  await assertTwitterApiUsable();
  const url = new URL("/twitter/user/mentions", config.TWITTERAPI_IO_BASE_URL);
  url.searchParams.set("userName", handle);
  const body = (await fetchPage(url)) as LastTweetsResponse & { tweets?: RawTweet[] };
  if (body.status !== "success") throw new Error(`twitterapi.io mentions: ${body.msg ?? "unknown error"}`);

  const tweets = body.tweets ?? body.data?.tweets ?? [];
  const mentions: XMention[] = [];
  for (const t of tweets) {
    const text = (t.text ?? "").trim();
    const author = (t as { author?: { userName?: string; followers?: number } }).author;
    if (!t.id || !text || !author?.userName) continue;
    if (author.userName.toLowerCase() === handle.toLowerCase()) continue; // their own tweet in the thread
    const date = t.createdAt ? new Date(t.createdAt) : new Date();
    mentions.push({
      externalId: t.id,
      url: t.url ?? null,
      authorHandle: author.userName,
      authorReach: author.followers ?? 0,
      content: text,
      postedAt: Number.isNaN(date.getTime()) ? new Date() : date,
    });
  }
  return mentions;
}
