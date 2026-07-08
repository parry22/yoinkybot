import { config } from "../../config.js";
import { runApifyActor, str, num } from "../../lib/apify.js";
import type { FetchOpts, Trend, TrendProvider } from "../provider.js";

/**
 * X + LinkedIn trends via Apify managed actors (run-sync REST API). Apify hosts
 * and maintains the scrapers, so anti-bot upkeep and ban exposure sit with the
 * platform, not this codebase. Field mappings below are verified against live
 * runs of the specific actors named in config (2026-07-04) — if the actor
 * changes, `parseXTrendItems`/`parseLinkedInTrendItems` are the functions to fix.
 */
export const apifyProvider: TrendProvider = {
  name: "apify",
  isConfigured: () => !!config.APIFY_TOKEN,
  async fetchTrends({ themes, limit }: FetchOpts): Promise<Trend[]> {
    const perPlatform = Math.max(3, Math.ceil(limit / 2));
    const [x, linkedin] = await Promise.allSettled([
      runXActor(themes, perPlatform),
      runLinkedInActor(themes, perPlatform),
    ]);
    const out: Trend[] = [];
    if (x.status === "fulfilled") out.push(...x.value);
    else console.error("apify x actor failed", x.reason);
    if (linkedin.status === "fulfilled") out.push(...linkedin.value);
    else console.error("apify linkedin actor failed", linkedin.reason);
    return out.slice(0, limit);
  },
};

/**
 * Parse raw items from kaitoeasyapi/twitter-x-data-tweet-scraper. Field shape
 * verified live: text, id, url/twitterUrl, likeCount, retweetCount.
 */
export function parseXTrendItems(items: unknown[]): Trend[] {
  const trends: Trend[] = [];
  for (const raw of items) {
    const t = raw as Record<string, unknown>;
    if (t["noResults"]) continue;
    const text = str(t["text"]);
    const id = str(t["id"]);
    if (!text || !id) continue;
    const likes = num(t["likeCount"]);
    const retweets = num(t["retweetCount"]);
    trends.push({
      externalId: id,
      platform: "x",
      topic: text.slice(0, 120),
      summary: text.slice(0, 400),
      url: str(t["url"] ?? t["twitterUrl"]) || undefined,
      volume: likes + 2 * retweets,
      observedAt: new Date().toISOString(),
      source: "apify",
    });
  }
  // Highest-engagement first — that's the "trend" signal.
  return trends.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

async function runXActor(themes: string[], limit: number): Promise<Trend[]> {
  const items = await runApifyActor(config.APIFY_X_ACTOR, {
    twitterContent: themes.slice(0, 3).join(" OR "),
    queryType: "Top",
    maxItems: limit * 2,
    min_faves: 100,
  });
  return parseXTrendItems(items).slice(0, limit);
}

/**
 * Parse raw items from harvestapi/linkedin-post-search. Field shape verified
 * live: content (not "text"), id, linkedinUrl, engagement.likes/comments.
 */
export function parseLinkedInTrendItems(items: unknown[]): Trend[] {
  const trends: Trend[] = [];
  for (const raw of items) {
    const t = raw as Record<string, unknown>;
    const text = str(t["content"]);
    const id = str(t["id"]);
    if (!text || !id) continue;
    const engagement = (t["engagement"] ?? {}) as Record<string, unknown>;
    const likes = num(engagement["likes"]);
    const comments = num(engagement["comments"]);
    trends.push({
      externalId: id,
      platform: "linkedin",
      topic: text.slice(0, 120),
      summary: text.slice(0, 400),
      url: str(t["linkedinUrl"]) || undefined,
      volume: likes + 3 * comments,
      observedAt: new Date().toISOString(),
      source: "apify",
    });
  }
  return trends.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

async function runLinkedInActor(themes: string[], limit: number): Promise<Trend[]> {
  const items = await runApifyActor(config.APIFY_LINKEDIN_ACTOR, {
    searchQueries: themes.slice(0, 3),
    maxPosts: limit * 2,
    sortBy: "relevance",
  });
  return parseLinkedInTrendItems(items).slice(0, limit);
}
