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

/**
 * Filler in a product one-liner: it describes the sentence, not the category. X
 * ANDs every bare word in a query, so leaving these in guarantees zero results.
 */
const CATEGORY_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "that", "this", "with", "without", "from",
  "into", "onto", "on", "in", "at", "by", "as", "is", "are", "be", "been", "it", "its", "their",
  "your", "our", "my", "who", "which", "when", "turns", "turn", "helps", "help", "helping",
  "makes", "make", "making", "builds", "build", "using", "use", "used", "lets", "let", "so",
  "they", "you", "we", "more", "less", "best", "new", "other", "all", "every", "any", "daily",
  "weekly", "monthly", "automatically", "easily", "quickly",
]);

/**
 * Words that are content, not category. Fine inside a quoted pair ("landing
 * page"), useless as a standalone search term — `(people OR meals)` matches half
 * of X and spends the search budget on noise the niche gate then throws away.
 */
const GENERIC_NOUNS = new Set([
  "people", "person", "thing", "things", "stuff", "users", "user", "customers", "customer",
  "clients", "client", "business", "businesses", "company", "companies", "team", "teams",
  "tool", "tools", "app", "apps", "platform", "software", "service", "services", "product",
  "products", "solution", "solutions", "system", "systems", "work", "time", "way", "ways",
]);

/** Content words of the one-liner, in order, with their original position. */
function contentTokens(raw: string): { tok: string; idx: number }[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((tok, idx) => ({ tok, idx }))
    .filter(({ tok }) => tok.length >= 2 && !CATEGORY_STOPWORDS.has(tok));
}

/**
 * The product's category as a search-usable OR-GROUP, e.g.
 * `("ai ghostwriter" OR ghostwriter OR linkedin)`.
 *
 * This must never be a bare multi-word phrase. X advanced_search ANDs every bare
 * word, so `("looking for" OR ...) AI ghostwriter that turns founders'` requires
 * all five of those words in one tweet and returns nothing, always. Verified live
 * 2026-07-23: the bare-phrase form returned 0 at every lookback window while the
 * OR-group form returned a full page inside 72h.
 */
export function categoryGroup(icp: IcpProfile): string {
  const toks = contentTokens(icp.product_oneliner ?? "");
  if (toks.length === 0) return "";
  const terms: string[] = [];
  // An adjacent pair is the precise term ("landing page", "ai ghostwriter") —
  // quoted, so it stays a phrase rather than two AND-ed words.
  const [first, second] = toks;
  if (first && second && second.idx === first.idx + 1) terms.push(`"${first.tok} ${second.tok}"`);
  // Then the most specific singles. Longer word ≈ more specific category noun;
  // ties keep the one-liner's own order. Generic nouns are only allowed back in
  // when nothing more specific exists — an over-broad query still beats none.
  const usable = toks.filter((t) => t.tok.length >= 4).slice(0, 6);
  const specific = usable.filter((t) => !GENERIC_NOUNS.has(t.tok));
  const singles = (specific.length > 0 ? specific : usable)
    .sort((a, b) => b.tok.length - a.tok.length || a.idx - b.idx)
    .slice(0, 2)
    .map((t) => t.tok);
  for (const s of singles) if (!terms.includes(s)) terms.push(s);
  if (terms.length === 0) return "";
  return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
}

/**
 * True when a query ANDs a run of bare words. Every one of them must appear in
 * the same tweet, so anything past a couple of terms reliably matches nothing —
 * the single most common way a distilled query goes silently dead. Quoted
 * phrases, OR-groups and operators are excluded from the count.
 */
export function tooNarrow(q: string): boolean {
  const bare = q
    .replace(/"[^"]*"/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/-?\b\w+:\S+/g, " ")
    .replace(/\b(OR|AND)\b/gi, " ");
  return bare.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length > 2;
}

/** Deterministic query set, best-signal-first — the fallback when the LLM is unavailable. */
export function fallbackQueries(icp: IcpProfile): IntentQuery[] {
  const cat = categoryGroup(icp);
  const out: IntentQuery[] = [];
  if (cat) {
    out.push({ q: `("looking for" OR "recommend" OR "anyone use" OR "best tool for") ${cat}`, bucket: "explicit_ask" });
    out.push({ q: `("any recommendations" OR "what do you use" OR "suggestions for") ${cat}`, bucket: "explicit_ask" });
    out.push({ q: `("just started" OR "we're scaling" OR "just launched") ${cat}`, bucket: "trigger_event" });
  }
  for (const comp of icp.competitor_terms.slice(0, 2)) {
    out.push({ q: `("switching from" OR "alternative to") "${comp}"`, bucket: "competitor_dissatisfaction" });
  }
  // Pain phrasings are already specific — AND-ing the category on top of a quoted
  // phrase is what killed these queries before. The niche gate does that narrowing.
  for (const pain of icp.pain_signals.slice(0, 3)) {
    out.push({ q: `"${pain}"`, bucket: "pain" });
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
    // Drop dead-on-arrival queries before they cost a paid search.
    const usable = parsed.queries.filter((q) => !tooNarrow(q.q));
    if (usable.length >= 2) return usable.slice(0, config.BUYER_MAX_QUERIES);
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

/**
 * Tweet ids already considered + authors within the cooldown window (dedup ledger).
 * The cooldown exists so the user isn't shown the same prospect twice, so it only
 * counts authors actually SURFACED to them — a 'rejected' row is a model decline
 * the user never saw, and blocking that author for three weeks was silently
 * shrinking the candidate pool with every scan.
 */
async function seenState(userId: string): Promise<{ tweetIds: Set<string>; cooledAuthors: Set<string> }> {
  const rows = await query<{ tweet_id: string; author_handle: string; in_window: boolean }>(
    `SELECT tweet_id, author_handle,
            (verdict <> 'rejected' AND surfaced_at > now() - ($2 || ' days')::interval) AS in_window
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

  const [handle, seen] = await Promise.all([ownHandle(userId), seenState(userId)]);

  // Search strongest bucket first so a tweet's provenance is its best bucket.
  const ordered = [...queries].sort((a, b) => BUCKET_PRIORITY.indexOf(a.bucket) - BUCKET_PRIORITY.indexOf(b.bucket));
  const byId = new Map<string, BuyerCandidate>();

  const runPass = async (set: IntentQuery[], lookbackHours: number): Promise<void> => {
    const sinceTime = Math.floor((Date.now() - lookbackHours * 3_600_000) / 1000);
    for (const { q, bucket } of set) {
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
  };

  await runPass(ordered, config.BUYER_LOOKBACK_HOURS);

  // A niche category can simply have no in-window volume. Rather than report an
  // empty radar, widen the window once over the strongest queries only (bounded:
  // 3 extra searches). Age still costs these candidates their recency component,
  // so a stale "looking for" has to be strong elsewhere to clear the intent gate.
  if (byId.size === 0) {
    await runPass(ordered.slice(0, 3), config.BUYER_LOOKBACK_HOURS * config.BUYER_WIDEN_FACTOR);
  }
  return [...byId.values()];
}
