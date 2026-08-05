/**
 * Buyer Radar discovery: ICP → keyword research → intent-shaped X advanced_search
 * queries → candidate tweets, deterministically pre-filtered (recency, no
 * replies/retweets, not the user's own, deduped against prior signals + author
 * cooldown).
 *
 * The load-bearing path is searchTweets (returns tweets directly). Query
 * distillation is LLM-assisted with a deterministic fallback, so it never hard-
 * depends on the model. All paid search is BOUNDED (page cap × query cap); the
 * monthly budget is enforced by the caller (buyer/scan.ts) BEFORE this runs.
 *
 * SUPPLY IS THE JOB. Everything downstream of here can only narrow - the intent
 * gate, the niche gate and the plan cap all subtract. So discovery runs a
 * WIDENING LADDER rather than a single pass: it keeps loosening one constraint at
 * a time (lookback → the author cooldown → a bare vocabulary sweep with no intent
 * phrase at all) until it has enough candidates or runs out of rungs. Each rung is
 * individually bounded, so the worst case is still a fixed number of paid searches.
 */
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { buyerQueriesV2 } from "../prompts/buyer-queries.v2.js";
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

/** What discovery did, so an empty radar can name the rung it died on. */
export interface DiscoveryTrace {
  /** Buyer-vocabulary terms the research step produced (model or fallback). */
  vocabulary: string[];
  /** Queries actually executed. */
  queriesRun: number;
  /** Ladder rungs used - see LADDER below. */
  rungs: string[];
  /** True when the LLM research step produced usable output. */
  llmQueries: boolean;
}

export interface DiscoveryResult {
  candidates: BuyerCandidate[];
  trace: DiscoveryTrace;
}

// Order matters: on a duplicate tweet across buckets, the first (strongest) bucket
// wins as its provenance.
const BUCKET_PRIORITY: IntentType[] = ["explicit_ask", "competitor_dissatisfaction", "pain", "trigger_event"];

const queriesSchema = z.object({
  vocabulary: z.array(z.string()).catch([]),
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
  "weekly", "monthly", "automatically", "easily", "quickly", "early", "stage", "first", "paid",
  "shipping", "want", "wants", "need", "needs", "get", "getting", "like", "just",
]);

/**
 * Words that are content, not category. Fine inside a quoted pair ("landing
 * page"), useless as a standalone search term - `(people OR meals)` matches half
 * of X and spends the search budget on noise the niche gate then throws away.
 */
const GENERIC_NOUNS = new Set([
  "people", "person", "thing", "things", "stuff", "users", "user", "customers", "customer",
  "clients", "client", "business", "businesses", "company", "companies", "team", "teams",
  "tool", "tools", "app", "apps", "platform", "software", "service", "services", "product",
  "products", "solution", "solutions", "system", "systems", "work", "time", "way", "ways",
]);

/** Content words of a phrase, in order, with their original position. */
function contentTokens(raw: string): { tok: string; idx: number }[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((tok, idx) => ({ tok, idx }))
    .filter(({ tok }) => tok.length >= 2 && !CATEGORY_STOPWORDS.has(tok));
}

/**
 * Deterministic buyer vocabulary - the fallback for the model's research step.
 *
 * Pulls from BOTH the product one-liner and the buyer description, because those
 * two sentences use different words for the same market and either one alone is
 * too thin to search on. Quoted adjacent pairs ("landing page") are kept as
 * phrases; single words are ranked most-specific-first.
 */
export function buyerVocabulary(icp: IcpProfile): string[] {
  const terms: string[] = [];
  const push = (t: string) => {
    const clean = t.trim();
    if (clean && !terms.includes(clean)) terms.push(clean);
  };

  // The user's own pain phrasings go FIRST. They are the only terms here already
  // written in the buyer's voice rather than the seller's, so they must survive
  // the length cap - appending them let a wordy one-liner crowd them out entirely.
  for (const p of icp.pain_signals.slice(0, 3)) push(p.toLowerCase().slice(0, 40));

  for (const source of [icp.product_oneliner ?? "", icp.buyer_description ?? ""]) {
    const toks = contentTokens(source);
    // An adjacent pair is the precise term ("landing page", "ai ghostwriter").
    for (let i = 0; i < Math.min(toks.length - 1, 3); i++) {
      const a = toks[i]!;
      const b = toks[i + 1]!;
      if (b.idx === a.idx + 1 && !GENERIC_NOUNS.has(a.tok)) push(`${a.tok} ${b.tok}`);
    }
    // Then the most specific singles. Longer word ≈ more specific category noun;
    // ties keep the source's own order. Generic nouns come back only when nothing
    // more specific exists - an over-broad term still beats none.
    const usable = toks.filter((t) => t.tok.length >= 4);
    const specific = usable.filter((t) => !GENERIC_NOUNS.has(t.tok));
    for (const t of (specific.length > 0 ? specific : usable)
      .sort((a, b) => b.tok.length - a.tok.length || a.idx - b.idx)
      .slice(0, 3))
      push(t.tok);
  }
  return terms.slice(0, 10);
}

/** Vocabulary terms as one search-usable OR-group: `("ai ghostwriter" OR ghostwriter)`. */
export function orGroup(terms: string[], limit = 4): string {
  const parts = terms
    .slice(0, limit)
    .map((t) => (t.includes(" ") ? `"${t}"` : t))
    .filter(Boolean);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
}

/**
 * True when a query ANDs a run of bare words. Every one of them must appear in
 * the same tweet, so anything past a couple of terms reliably matches nothing -
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

/** Deterministic query set, best-signal-first - the fallback when the LLM is unavailable. */
export function fallbackQueries(icp: IcpProfile, vocabulary: string[]): IntentQuery[] {
  const cat = orGroup(vocabulary, 4);
  const wide = orGroup(vocabulary, 6);
  const out: IntentQuery[] = [];
  if (cat) {
    out.push({ q: `("looking for" OR "recommend" OR "anyone use" OR "best tool for") ${cat}`, bucket: "explicit_ask" });
    out.push({ q: `("any recommendations" OR "what do you use" OR "suggestions for") ${cat}`, bucket: "explicit_ask" });
    out.push({ q: `("need help with" OR "need someone" OR "hiring") ${wide}`, bucket: "explicit_ask" });
    out.push({ q: `("just started" OR "we're scaling" OR "just launched") ${cat}`, bucket: "trigger_event" });
    out.push({ q: `("struggling with" OR "tired of" OR "sick of") ${wide}`, bucket: "pain" });
  }
  for (const comp of icp.competitor_terms.slice(0, 2)) {
    out.push({ q: `("switching from" OR "alternative to") "${comp}"`, bucket: "competitor_dissatisfaction" });
  }
  // Pain phrasings are already specific - AND-ing the category on top of a quoted
  // phrase is what killed these queries before. The niche gate does that narrowing.
  for (const pain of icp.pain_signals.slice(0, 3)) {
    out.push({ q: `"${pain}"`, bucket: "pain" });
  }
  return out.slice(0, config.BUYER_MAX_QUERIES);
}

export interface DerivedQueries {
  queries: IntentQuery[];
  vocabulary: string[];
  fromLlm: boolean;
}

/**
 * Research the buyer's vocabulary, then distill it into intent queries.
 * LLM-assisted; falls back to a deterministic composition of the ICP's own words
 * when the model yields < 2 usable queries.
 */
export async function deriveIntentQueries(userId: string, icp: IcpProfile): Promise<DerivedQueries> {
  const deterministicVocab = buyerVocabulary(icp);
  try {
    const res = await llmCall({
      userId,
      eventType: "search",
      tier: buyerQueriesV2.tier,
      system: buyerQueriesV2.system,
      user: buyerQueriesV2.render({
        productOneliner: icp.product_oneliner ?? "",
        buyerDescription: icp.buyer_description ?? "",
        painSignals: icp.pain_signals,
        competitorTerms: icp.competitor_terms,
        exclusions: icp.exclusions,
      }),
      json: true,
      maxTokens: 900,
    });
    const parsed = queriesSchema.parse(res.parsed);
    // Drop dead-on-arrival queries before they cost a paid search.
    const usable = parsed.queries.filter((q) => !tooNarrow(q.q));
    // The researched vocabulary is worth keeping even when the queries aren't -
    // the widening ladder searches it directly on its last rung.
    const vocabulary = dedupeTerms([
      ...parsed.vocabulary.map((v) => v.toLowerCase().trim()).filter((v) => v.length >= 2 && v.length <= 40),
      ...deterministicVocab,
    ]);
    if (usable.length >= 2) {
      return { queries: usable.slice(0, config.BUYER_MAX_QUERIES), vocabulary, fromLlm: true };
    }
    return { queries: fallbackQueries(icp, vocabulary), vocabulary, fromLlm: false };
  } catch (err) {
    console.error("buyer query distillation failed, using deterministic fallback", err);
    return { queries: fallbackQueries(icp, deterministicVocab), vocabulary: deterministicVocab, fromLlm: false };
  }
}

function dedupeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 14);
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
 * counts authors actually SURFACED to them - a 'rejected' row is a decline the
 * user never saw, and blocking that author for three weeks was silently shrinking
 * the candidate pool with every scan.
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
 * The widening ladder. Each rung loosens exactly ONE constraint relative to the
 * one above it, so when a scan comes back thin the trace names which loosening
 * was still not enough. Rungs run in order and stop as soon as the candidate
 * target is met - a healthy niche never pays for rungs 2-4.
 */
interface Rung {
  name: string;
  /** Lookback multiplier over BUYER_LOOKBACK_HOURS. */
  widen: number;
  /** How many of the (bucket-ordered) queries to run on this rung. */
  queryLimit: number;
  /** Ignore the repeat-author cooldown - a known-good prospect beats an empty radar. */
  ignoreCooldown?: boolean;
  /** Search bare vocabulary with no intent phrase at all (widest, lowest precision). */
  bareVocabulary?: boolean;
}

const LADDER: Rung[] = [
  { name: "in-window", widen: 1, queryLimit: config.BUYER_MAX_QUERIES },
  { name: "widened", widen: config.BUYER_WIDEN_FACTOR, queryLimit: 4 },
  { name: "cooldown-off", widen: config.BUYER_WIDEN_FACTOR, queryLimit: 4, ignoreCooldown: true },
  { name: "bare-vocabulary", widen: config.BUYER_WIDEN_FACTOR, queryLimit: 2, ignoreCooldown: true, bareVocabulary: true },
];

/**
 * Run discovery for one user and return deduped, pre-filtered candidates tagged
 * with their intent bucket. Throws if TWITTERAPI_IO_KEY is unset (the caller
 * fail-closes with a plain "not available" message).
 *
 * `minCandidates` is the supply target the ladder climbs toward. It is
 * deliberately several times the number of leads the scan will surface: the
 * intent gate and the niche gate both subtract, so aiming at exactly six here
 * would reliably deliver two.
 */
export async function discoverCandidates(
  userId: string,
  icp: IcpProfile,
  minCandidates = 24,
): Promise<DiscoveryResult> {
  if (!config.TWITTERAPI_IO_KEY) throw new Error("TWITTERAPI_IO_KEY not configured");
  const derived = await deriveIntentQueries(userId, icp);
  const trace: DiscoveryTrace = {
    vocabulary: derived.vocabulary,
    queriesRun: 0,
    rungs: [],
    llmQueries: derived.fromLlm,
  };
  if (derived.queries.length === 0 && derived.vocabulary.length === 0) {
    return { candidates: [], trace };
  }

  const [handle, seen] = await Promise.all([ownHandle(userId), seenState(userId)]);

  // Search strongest bucket first so a tweet's provenance is its best bucket.
  const ordered = [...derived.queries].sort(
    (a, b) => BUCKET_PRIORITY.indexOf(a.bucket) - BUCKET_PRIORITY.indexOf(b.bucket),
  );
  // The last rung searches vocabulary with no intent phrase. It is the widest
  // thing we can ask for, so it is tagged 'pain' (the weakest provenance weight)
  // rather than pretending it found an explicit ask.
  const bareQueries: IntentQuery[] = (
    [
      { q: orGroup(derived.vocabulary, 4), bucket: "pain" },
      { q: orGroup(derived.vocabulary.slice(4), 4), bucket: "pain" },
    ] satisfies IntentQuery[]
  ).filter((q) => q.q.length > 0);

  const byId = new Map<string, BuyerCandidate>();

  const runPass = async (set: IntentQuery[], lookbackHours: number, ignoreCooldown: boolean): Promise<void> => {
    const sinceTime = Math.floor((Date.now() - lookbackHours * 3_600_000) / 1000);
    for (const { q, bucket } of set) {
      if (!q.trim()) continue;
      let tweets: XTweet[] = [];
      try {
        trace.queriesRun++;
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
        if (!ignoreCooldown && author && seen.cooledAuthors.has(author)) continue; // repeat-prospect cooldown
        if (byId.has(t.id)) continue; // first (strongest) bucket keeps provenance
        byId.set(t.id, { tweet: t, provenance: bucket });
      }
    }
  };

  for (const rung of LADDER) {
    if (byId.size >= minCandidates) break;
    const set = rung.bareVocabulary ? bareQueries : ordered.slice(0, rung.queryLimit);
    if (set.length === 0) continue;
    trace.rungs.push(rung.name);
    await runPass(set, config.BUYER_LOOKBACK_HOURS * rung.widen, rung.ignoreCooldown === true);
  }

  return { candidates: [...byId.values()], trace };
}
