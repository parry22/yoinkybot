import { z } from "zod";
import { config } from "../config.js";
import { llmCall } from "../llm/gateway.js";
import { searchTweets, type XTweet } from "../capture/imports/twitterapi-io.js";
import { trendClusters } from "../prompts/trend-clusters.v1.js";
import { verifyTrendVolume, twitterapiConfigured } from "./providers/twitterapi.js";
import type { Trend } from "./provider.js";

/**
 * Same-day X trend discovery, cluster-first (2026-07-12).
 *
 * The old model stored each hot tweet as a "trend" with its verbatim text as the
 * topic — so volume verification searched that exact sentence and found only the
 * original tweet (buzz ~0.15, nothing ever fired). This instead does what a
 * trend actually is:
 *   1. Pull RECENT (last 24h) high-engagement tweets around the user base's
 *      interest terms — the raw same-day material.
 *   2. LLM-cluster them into the distinct topics multiple accounts are on right
 *      now (trend-clusters.v1), each labeled with a SEARCHABLE term + the single
 *      driving tweet.
 *   3. Verify each term's live volume deterministically (verifyTrendVolume →
 *      buzzScore over the last 24h). Only clusters that genuinely clear the buzz
 *      bar survive — real "everyone's talking about this today", not one tweet.
 * Each surviving cluster becomes a Trend whose topic is the term (so downstream
 * verification actually works), url is the driving tweet (the source post the
 * user engages with), and observed_at is that tweet's time (freshness).
 */

const HOURS = 24;
const MAX_SEED_TWEETS = 60;

const clusterSchema = z.object({
  trends: z
    .array(
      z.object({
        term: z.string().min(2).max(60),
        description: z.string().catch(""),
        driver_id: z.string().catch(""),
        author_count_estimate: z.number().catch(0),
      }),
    )
    .catch([]),
});

/** Build a recency-windowed OR query across the interest terms. */
function seedQuery(themes: string[]): string {
  const terms = themes
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t));
  return `(${terms.join(" OR ")}) -filter:replies lang:en`;
}

const engagement = (t: XTweet) => t.likeCount + t.retweetCount + t.replyCount;

export async function discoverXTrends(themes: string[], limit: number): Promise<Trend[]> {
  if (!twitterapiConfigured() || themes.length === 0) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - HOURS * 3600;

  // 1. Same-day raw material: recent tweets on the interest terms. queryType
  //    "Latest" (NOT "Top" — twitterapi's "Top" returns nothing for windowed
  //    queries); min_faves keeps it to tweets with some traction, and we rank by
  //    engagement in code below.
  let seed: XTweet[] = [];
  try {
    seed = await searchTweets(`${seedQuery(themes)} min_faves:10`, {
      queryType: "Latest",
      sinceTime: sinceSec,
      untilTime: nowSec,
      maxPages: config.TWITTERAPI_SEARCH_PAGE_CAP,
    });
  } catch (err) {
    console.error("discoverXTrends: seed search failed", err);
    return [];
  }
  const pool = new Map<string, XTweet>();
  for (const t of seed) pool.set(t.id, t);
  const topSeed = [...pool.values()].sort((a, b) => engagement(b) - engagement(a)).slice(0, MAX_SEED_TWEETS);

  // 2. Cluster the same-day material into specific topic TERMS + their driving
  //    tweet. This is an enhancement, not a dependency: GLM's JSON is flaky, so
  //    a failed/empty clustering call just leaves the theme terms below to carry
  //    the run. Each entry: { term, driverId }.
  const candidates = new Map<string, { term: string; description: string; driverId: string }>();
  if (topSeed.length > 0) {
    try {
      const res = await llmCall({
        userId: null, // system job — exempt from per-user caps
        eventType: "trend_clusters",
        tier: trendClusters.tier,
        system: trendClusters.system,
        user: trendClusters.render({
          tweets: topSeed.map((t) => ({ id: t.id, handle: t.authorHandle, text: t.text, engagement: engagement(t) })),
        }),
        json: true,
        maxTokens: 1200,
      });
      for (const c of clusterSchema.parse(res.parsed).trends) {
        const key = c.term.toLowerCase();
        if (!candidates.has(key)) candidates.set(key, { term: c.term, description: c.description, driverId: c.driver_id });
      }
    } catch (err) {
      console.error("discoverXTrends: clustering failed, falling back to theme terms", err);
    }
  }
  // Always add the interest terms as reliable fallback candidates — they're
  // already searchable, and their top same-day tweet is a real driving post.
  for (const th of themes) {
    const key = th.toLowerCase();
    if (!candidates.has(key)) candidates.set(key, { term: th, description: "", driverId: "" });
  }

  // 3. Verify each candidate TERM's live volume (the search that now works) and
  //    ground it in its freshest driving tweet. Keep those clearing the buzz bar,
  //    strongest first, up to `limit`.
  const scored: Array<{ trend: Trend; buzz: number }> = [];
  // Cap verified terms per run — each is ~6 rate-limited twitterapi requests.
  // Cluster terms come first (Map preserves insertion order), so the specific
  // same-day topics are verified before the broad theme fallbacks.
  for (const c of [...candidates.values()].slice(0, 6)) {
    let verification;
    try {
      verification = await verifyTrendVolume(c.term, true);
    } catch (err) {
      console.error(`discoverXTrends: verify failed for "${c.term}"`, err);
      continue;
    }
    if (verification.buzz <= config.BUZZ_THRESHOLD) continue;

    // Source post: the LLM's chosen driver if it's in the seed pool, else the
    // strongest verified tweet for the term. Never emit a term we can't ground
    // in a real, linkable tweet.
    const driver = pool.get(c.driverId) ?? verification.topTweets[0];
    if (!driver?.url) continue;

    scored.push({
      buzz: verification.buzz,
      trend: {
        externalId: driver.id, // dedup on the driving tweet
        platform: "x",
        topic: c.term,
        summary: c.description || driver.text.slice(0, 300),
        url: driver.url,
        volume: verification.buzz,
        observedAt: driver.createdAt.toISOString(),
        source: "twitterapi",
      },
    });
  }
  return scored.sort((a, b) => b.buzz - a.buzz).slice(0, limit).map((s) => s.trend);
}
