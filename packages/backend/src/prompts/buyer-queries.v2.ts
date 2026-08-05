import type { Prompt } from "./types.js";

export interface BuyerQueriesV2Vars {
  /** What the user sells, plain. */
  productOneliner: string;
  /** Who the buyer is (role, company stage, context). */
  buyerDescription: string;
  /** Phrasings a buyer uses when in-market (from the ICP). */
  painSignals: string[];
  /** Competitor names/products - seed "switching from X" / "X alternative" queries. */
  competitorTerms: string[];
  /** Contexts that are NOT the buyer, so the model doesn't aim at them. */
  exclusions: string[];
}

/**
 * v2 - keyword RESEARCH, then queries.
 *
 * v1 asked straight for queries and got back near-verbatim restatements of the
 * product one-liner. That is the single reason the radar found nobody: a founder
 * writes "AI ghostwriter for B2B founders", v1 searched `("looking for") ("ai
 * ghostwriter" OR ghostwriter)`, and roughly nobody on X types the seller's own
 * category name. Buyers describe the JOB ("need someone to write my linkedin
 * posts"), the ROLE ("ghostwriter", "content person"), or the PAIN ("no time to
 * post consistently") - three vocabularies the seller's phrasing never contains.
 *
 * So the model now does an explicit expansion step first (`vocabulary`), and the
 * queries are built from THAT rather than from the one-liner. The expansion is
 * also returned to the caller, which reuses it for the deterministic broad sweep
 * when the model is unavailable (buyer/discovery.ts).
 *
 * Buckets are unchanged (the caller tags each query and scores by bucket) -
 * scoring in buyer/scoring.ts depends on them.
 */
export const buyerQueriesV2: Prompt<BuyerQueriesV2Vars> = {
  id: "buyer-queries",
  version: 2,
  tier: "cheap",
  system: `You do keyword research for finding BUYERS on X/Twitter, then turn it into
advanced_search queries.

STEP 1 - VOCABULARY. Before writing any query, expand what's sold into the words a
BUYER would actually type. The seller's own category name is usually NOT one of them.
Produce 6-12 short terms across these kinds:
- the JOB the buyer wants done ("write my linkedin posts", "book more calls")
- the ROLE or thing they'd hire/buy ("ghostwriter", "fractional cmo", "crm")
- the PAIN in their words ("no time to post", "leads dried up")
- adjacent/jargon terms insiders use for this category
Each term: 1-3 words, lowercase, no punctuation. A term is good if a stranger with
this problem might plausibly type it in a tweet. Do NOT include the seller's brand.

STEP 2 - QUERIES. Write 8-12 queries built from that vocabulary.
- Each pairs an intent phrase with vocabulary terms as an OR-group.
- Operators allowed: quoted phrases, OR groups in parentheses. Nothing else - the
  caller adds recency, language and reply filters itself. No since:/until:/min_faves:.
- CRITICAL: X ANDs every bare (unquoted) word. Never leave more than two bare words
  loose, or every one of them has to appear in the same tweet and it matches nothing.
  GOOD: ("looking for" OR "recommend") ("ghostwriter" OR "linkedin writer")
  DEAD: ("looking for" OR "recommend") AI ghostwriter that turns founders ideas
- Tag every query with its bucket:
  - "explicit_ask": ("looking for" OR "recommend" OR "anyone use" OR "best tool for") <vocab>
  - "competitor_dissatisfaction": ("switching from" OR "alternative to") "<competitor>"
  - "pain": the quoted pain phrasing ALONE. Never AND the category onto it.
  - "trigger_event": ("just started" OR "just launched" OR "we're hiring" OR "we're scaling") <vocab>
- RECALL BEATS PRECISION here. Two of the queries must be deliberately WIDE - an
  intent phrase against the broadest 3-4 vocabulary terms you have. A later scoring
  and domain-similarity pass throws away what doesn't fit, but it can only ever
  narrow what search returned. An empty result set is the one failure it cannot fix.
- Skip competitor_dissatisfaction only if no competitor is given. Skip nothing else.

Respond with ONLY valid JSON:
{"vocabulary": ["..."], "queries": [{"q": "...", "bucket": "explicit_ask|competitor_dissatisfaction|pain|trigger_event"}]}`,
  render: ({ productOneliner, buyerDescription, painSignals, competitorTerms, exclusions }) =>
    [
      productOneliner ? `PRODUCT (what's sold):\n${productOneliner}` : "",
      buyerDescription ? `BUYER (who buys it):\n${buyerDescription}` : "",
      painSignals.length ? `IN-MARKET PHRASINGS THEY GAVE:\n${painSignals.map((p) => `- ${p}`).join("\n")}` : "",
      competitorTerms.length ? `COMPETITORS:\n${competitorTerms.map((c) => `- ${c}`).join("\n")}` : "",
      exclusions.length
        ? `NOT THE BUYER (don't aim vocabulary at these):\n${exclusions.map((e) => `- ${e}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
};
