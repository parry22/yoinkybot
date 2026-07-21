/**
 * Buyer Radar discovery: ICP → intent-shaped X advanced_search queries →
 * candidate tweets, deterministically pre-filtered (recency, no replies/retweets,
 * not the user's own, deduped against prior signals + author cooldown).
 *
 * The load-bearing path is searchTweets (returns tweets directly). Query
 * distillation is LLM-assisted with a deterministic fallback, so it never hard-
 * depends on the model. All paid search is BOUNDED (page cap × query cap); the
 * monthly budget is enforced by the caller (buyer/scan.ts) BEFORE this runs.
 */
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { buyerQueries } from "../prompts/buyer-queries.v1.js";
import { searchTweets, type XTweet } from "../capture/imports/twitterapi-io.js";
import type { IcpProfile } from "./icp.js";
import type { IntentType } from "./scoring.js";

export interface IntentQuery {
  q: string;
  bucket: IntentType;
}

export interface BuyerCandidate {
  tweet: XTweet;
  provenance: IntentType;
}

// Order matters: on a duplicate tweet across buckets, the first (strongest) bucket
// wins as its provenance.
const BUCKET_PRIORITY: IntentType[] = ["explicit_ask", "competitor_dissatisfaction", "pain", "trigger_event"];

const queriesSchema = z.object({
  queries: z
    .array(
      z.object({
        q: z.string().min(3).max(240),
        bucket: z.enum(["explicit_ask", "competitor_dissatisfaction", "pain", "trigger_event"]),
      }),
    )
    .catch([]),
});

/** A short category phrase for the deterministic fallback queries. */
function categoryTerm(icp: IcpProfile): string {
  const raw = (icp.product_oneliner ?? "").trim();
  if (!raw) return "";
  // First ~5 words keeps the query broad enough to return results.
  return raw.split(/\s+/).slice(0, 5).join(" ");
}

/** Deterministic query set, best-signal-first — the fallback when the LLM is unavailable. */
export function fallbackQueries(icp: IcpProfile): IntentQuery[] {
  const cat = categoryTerm(icp);
  const out: IntentQuery[] = [];
  if (cat) {
    out.push({ q: `("looking for" OR "recommend" OR "anyone use" OR "best tool for") ${cat}`, bucket: "explicit_ask" });
    out.push({ q: `("just started" OR "we're scaling" OR "just launched") ${cat}`, bucket: "trigger_event" });
  }
  for (const comp of icp.competitor_terms.slice(0, 2)) {
    out.push({ q: `("switching from" OR "alternative to") "${comp}"`, bucket: "competitor_dissatisfaction" });
  }
  for (const pain of icp.pain_signals.slice(0, 3)) {
    out.push({ q: `"${pain}"${cat ? ` ${cat}` : ""}`, bucket: "pain" });
  }
  return out.slice(0, config.BUYER_MAX_QUERIES);
}

/**
 * Distill the ICP into intent queries. LLM-assisted; falls back to a deterministic
 * composition of pain × product × competitor terms when the model yields < 2.
 */
export async function deriveIntentQueries(userId: string, icp: IcpProfile): Promise<IntentQuery[]> {
  try {
    const res = await llmCall({
      userId,
      eventType: "search",
      tier: buyerQueries.tier,
      system: buyerQueries.system,
      user: buyerQueries.render({
        productOneliner: icp.product_oneliner ?? "",
        buyerDescription: icp.buyer_description ?? "",
        painSignals: icp.pain_signals,
        competitorTerms: icp.competitor_terms,
      }),
      json: true,
      maxTokens: 500,
    });
    const parsed = queriesSchema.parse(res.parsed);
    if (parsed.queries.length >= 2) return parsed.queries.slice(0, config.BUYER_MAX_QUERIES);
  } catch (err) {
    console.error("buyer query distillation failed, using deterministic fallback", err);
  }
  return fallbackQueries(icp);
}

/** The user's own X handle (so we never surface their own tweets as prospects). */
async function ownHandle(userId: string): Promise<string | null> {
  const rows = await query<{ handle: string }>(
    `SELECT handle FROM connected_accounts WHERE user_id = $1 AND platform = 'x' LIMIT 1`,
    [userId],
  );
  return rows[0]?.handle?.replace(/^@/, "").toLowerCase() ?? null;
}

/** Tweet ids already surfaced + authors within the cooldown window (dedup ledger). */
async function seenState(userId: string): Promise<{ tweetIds: Set<string>; cooledAuthors: Set<string> }> {
  const rows = await query<{ tweet_id: string; author_handle: string; in_window: boolean }>(
    `SELECT tweet_id, author_handle,
            (surfaced_at > now() - ($2 || ' days')::interval) AS in_window
     FROM buyer_signals WHERE user_id = $1`,
    [userId, String(config.BUYER_AUTHOR_COOLDOWN_DAYS)],
  );
  return {
    tweetIds: new Set(rows.map((r) => r.tweet_id)),
    cooledAuthors: new Set(rows.filter((r) => r.in_window).map((r) => r.author_handle.toLowerCase())),
  };
}

/**
 * Run discovery for one user and return deduped, pre-filtered candidates tagged
 * with their intent bucket. Throws if TWITTERAPI_IO_KEY is unset (the caller
 * fail-closes with a plain "not available" message).
 */
export async function discoverCandidates(userId: string, icp: IcpProfile): Promise<BuyerCandidate[]> {
  if (!config.TWITTERAPI_IO_KEY) throw new Error("TWITTERAPI_IO_KEY not configured");
  const queries = await deriveIntentQueries(userId, icp);
  if (queries.length === 0) return [];

  const sinceTime = Math.floor((Date.now() - config.BUYER_LOOKBACK_HOURS * 3_600_000) / 1000);
  const [handle, seen] = await Promise.all([ownHandle(userId), seenState(userId)]);

  // Search strongest bucket first so a tweet's provenance is its best bucket.
  const ordered = [...queries].sort((a, b) => BUCKET_PRIORITY.indexOf(a.bucket) - BUCKET_PRIORITY.indexOf(b.bucket));
  const byId = new Map<string, BuyerCandidate>();

  for (const { q, bucket } of ordered) {
    let tweets: XTweet[] = [];
    try {
      tweets = await searchTweets(`${q} lang:en -filter:replies`, {
        queryType: "Latest",
        sinceTime,
        maxPages: config.BUYER_SEARCH_PAGE_CAP,
      });
    } catch (err) {
      // One bad query (bad operator combo, transient error) must not sink the run.
      console.error(`buyer search failed for query "${q}"`, err);
      continue;
    }
    for (const t of tweets) {
      if (!t.id || !t.text.trim() || t.isReply) continue;
      const author = t.authorHandle.toLowerCase();
      if (handle && author === handle) continue; // never the user's own tweet
      if (seen.tweetIds.has(t.id)) continue; // already considered/surfaced
      if (author && seen.cooledAuthors.has(author)) continue; // repeat-prospect cooldown
      if (byId.has(t.id)) continue; // first (strongest) bucket keeps provenance
      byId.set(t.id, { tweet: t, provenance: bucket });
    }
  }
  return [...byId.values()];
}
