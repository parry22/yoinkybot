/**
 * Ad-hoc topic research for the chat brain: "what's actually being said about X
 * right now", answered on demand rather than from the nightly trend sweep.
 *
 * WHY THIS EXISTS. Compose could only draft from things already in memory. Ask it
 * for a post about a live topic and `hybridSearch` returned nothing, so drafting
 * declined with "capture some thinking on it first" - which reads as the product
 * refusing the most obvious request you could make of it. The writer already gets
 * `nearbyTrends` (drafting/draft.ts), but that only reads the cached `trends`
 * table, so it is empty for anything the fleet sweep didn't happen to pick up.
 *
 * Three sources, cheapest first, all best-effort:
 *   1. the cached `trends` table (free, already embedded, may be cold)
 *   2. LIVE X search via twitterapi.io (paid per tweet, bounded to one page -
 *      the primary source, because this is a product about X)
 *   3. the news/web provider chain (Brave/Tavily/Apify, whichever is configured)
 *
 * A source that is unconfigured or throws simply contributes nothing. Research
 * returning empty is a legitimate answer the caller reports honestly; it is never
 * an error.
 */
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { searchTweets } from "../capture/imports/twitterapi-io.js";
import { fetchTrendsWithFallback } from "./registry.js";

export interface ResearchedPost {
  handle: string;
  text: string;
  likes: number;
  url: string | null;
}

export interface ResearchedHeadline {
  topic: string;
  summary: string;
  url: string | null;
  source: string;
}

export interface TopicResearch {
  topic: string;
  /** Real tweets currently in the conversation, most-engaged first. */
  posts: ResearchedPost[];
  /** Cached trends + news headlines. */
  headlines: ResearchedHeadline[];
  /** Which sources actually answered - for honest "I couldn't find anything" copy. */
  sources: string[];
}

/** Live X conversation on a topic. One page, Top-sorted: the loudest, not the latest. */
async function liveTweets(topic: string, limit: number): Promise<ResearchedPost[]> {
  if (!config.TWITTERAPI_IO_KEY) return [];
  // Bare multi-word topics get AND-ed by X and match nothing, so anything with a
  // space is quoted (the same failure mode buyer/discovery.ts guards against).
  const q = /\s/.test(topic.trim()) ? `"${topic.trim()}"` : topic.trim();
  const sinceTime = Math.floor((Date.now() - RESEARCH_LOOKBACK_HOURS * 3_600_000) / 1000);
  const tweets = await searchTweets(`${q} lang:en -filter:replies`, {
    queryType: "Top",
    sinceTime,
    maxPages: 1,
  });
  return tweets
    .filter((t) => t.text.trim().length > 0)
    .sort((a, b) => b.likeCount - a.likeCount)
    .slice(0, limit)
    .map((t) => ({ handle: t.authorHandle, text: t.text, likes: t.likeCount, url: t.url }));
}

const RESEARCH_LOOKBACK_HOURS = 72;

/** Cached fleet trends nearest the topic. Free - one embed and one pgvector hop. */
async function cachedTrends(userId: string, topic: string, limit: number): Promise<ResearchedHeadline[]> {
  const vec = await embedOne(topic.slice(0, 1000), userId);
  const rows = await query<{ topic: string; summary: string | null; url: string | null; source: string }>(
    `SELECT topic, summary, url, source FROM trends
     WHERE embedding IS NOT NULL AND fetched_at > now() - interval '72 hours'
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    [JSON.stringify(vec), limit],
  );
  return rows.map((r) => ({ topic: r.topic, summary: r.summary ?? "", url: r.url, source: r.source }));
}

/** Fresh news/web search for the topic, through whichever provider is configured. */
async function liveHeadlines(topic: string, limit: number): Promise<ResearchedHeadline[]> {
  const { trends } = await fetchTrendsWithFallback({ themes: [topic], limit });
  return trends.map((t) => ({ topic: t.topic, summary: t.summary, url: t.url ?? null, source: t.source }));
}

/**
 * Research one topic. Every source is wrapped so a failure in one is invisible to
 * the others - the caller gets whatever came back.
 */
export async function researchTopic(
  userId: string,
  topic: string,
  opts: { maxPosts?: number; maxHeadlines?: number } = {},
): Promise<TopicResearch> {
  const maxPosts = opts.maxPosts ?? 8;
  const maxHeadlines = opts.maxHeadlines ?? 5;
  const sources: string[] = [];

  const settle = async <T>(name: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      const out = await fn();
      if (out.length > 0) sources.push(name);
      return out;
    } catch (err) {
      console.error(`topic research source ${name} failed for "${topic}"`, err);
      return [];
    }
  };

  const [posts, cached, fresh] = await Promise.all([
    settle("x", () => liveTweets(topic, maxPosts)),
    settle("trends", () => cachedTrends(userId, topic, maxHeadlines)),
    settle("web", () => liveHeadlines(topic, maxHeadlines)),
  ]);

  // Cached first (already domain-relevant to the fleet), then fresh web, deduped
  // on url so the same story doesn't appear twice under two provider names.
  const seen = new Set<string>();
  const headlines: ResearchedHeadline[] = [];
  for (const h of [...cached, ...fresh]) {
    const key = h.url ?? h.topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    headlines.push(h);
    if (headlines.length >= maxHeadlines) break;
  }

  return { topic, posts, headlines, sources };
}

/** Compact, model-readable rendering of research - the shape tool traces want. */
export function renderResearch(research: TopicResearch): string {
  const lines: string[] = [];
  if (research.posts.length > 0) {
    lines.push(`LIVE ON X (last ${RESEARCH_LOOKBACK_HOURS}h, most-engaged first):`);
    for (const p of research.posts) {
      lines.push(`- @${p.handle} (${p.likes} likes): ${p.text.slice(0, 240).replace(/\s+/g, " ")}`);
    }
  }
  if (research.headlines.length > 0) {
    if (lines.length) lines.push("");
    lines.push("IN THE NEWS:");
    for (const h of research.headlines) {
      lines.push(`- ${h.topic}${h.summary ? ` - ${h.summary.slice(0, 200)}` : ""}`);
    }
  }
  if (lines.length === 0) {
    return `nothing live found on "${research.topic}" - no X conversation in the last ${RESEARCH_LOOKBACK_HOURS}h and no news hits`;
  }
  return lines.join("\n");
}
