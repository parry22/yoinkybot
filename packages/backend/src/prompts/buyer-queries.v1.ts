import type { Prompt } from "./types.js";

export interface BuyerQueriesVars {
  /** What the user sells, plain. */
  productOneliner: string;
  /** Who the buyer is (role, company stage, context). */
  buyerDescription: string;
  /** Phrasings a buyer uses when in-market (from the ICP). */
  painSignals: string[];
  /** Competitor names/products — seed "switching from X" / "X alternative" queries. */
  competitorTerms: string[];
}

/**
 * Distills the ICP into a bounded set of X advanced_search queries shaped for
 * PURCHASE intent (not generic topic discovery — that's trend-themes). Mirrors
 * trend-themes.v1: short, uses the vocabulary buyers actually type, JSON only.
 * The caller (buyer/discovery.ts) has a deterministic fallback, so the model is
 * an upgrade, never a hard dependency.
 *
 * Buckets (the caller tags each returned query with its intent_type):
 * - explicit_ask: someone openly asking for a recommendation/tool/service.
 * - competitor_dissatisfaction: "switching from X", "X alternative".
 * - pain: a frustration the product removes.
 * - trigger_event: a moment that creates the need ("just started", "we're scaling").
 */
export const buyerQueries: Prompt<BuyerQueriesVars> = {
  id: "buyer-queries",
  version: 1,
  tier: "cheap",
  system: `You write X/Twitter advanced_search queries that surface people expressing
BUYING INTENT for a specific product or service, given a description of what's sold
and who buys it.

Rules:
- Return 4 to 8 queries. Each combines an intent phrase with the product's category
  vocabulary the way real buyers type it (short nouns, not sentences).
- Use these operators only: quoted phrases, OR groups in parentheses, and -filter:replies.
  Do NOT add since:/until:/min_faves: — the caller adds recency and floors itself.
- Cover the intent buckets, and tag EACH query with its bucket:
  - "explicit_ask": ("looking for" OR "recommend" OR "anyone use" OR "best tool for") <category>
  - "competitor_dissatisfaction": ("switching from" OR "alternative to") <competitor>
  - "pain": "<pain phrasing>" <category>
  - "trigger_event": ("just started" OR "we're scaling" OR "just launched") <context>
- CRITICAL: X ANDs every bare (unquoted) word, so a query must never leave more than
  two bare words loose — all of them would have to appear in the same tweet and it
  returns nothing. Put the category in an OR-group or quotes:
  GOOD: ("looking for" OR "recommend") ("ai ghostwriter" OR ghostwriter)
  DEAD: ("looking for" OR "recommend") AI ghostwriter that turns founders ideas
- Category vocabulary must be BROAD enough to return results ("email tool", not
  "the email tool I use for my B2B SaaS onboarding flow").
- A pain query is the quoted phrase on its own. Do NOT append the category to it —
  that ANDs two narrow things together and matches nobody.
- Skip competitor_dissatisfaction queries if no competitor is given. Skip nothing else.

Respond with ONLY valid JSON:
{"queries": [{"q": "...", "bucket": "explicit_ask|competitor_dissatisfaction|pain|trigger_event"}]}`,
  render: ({ productOneliner, buyerDescription, painSignals, competitorTerms }) =>
    [
      productOneliner ? `PRODUCT (what's sold):\n${productOneliner}` : "",
      buyerDescription ? `BUYER (who buys it):\n${buyerDescription}` : "",
      painSignals.length ? `IN-MARKET PHRASINGS:\n${painSignals.map((p) => `- ${p}`).join("\n")}` : "",
      competitorTerms.length ? `COMPETITORS:\n${competitorTerms.map((c) => `- ${c}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
};
