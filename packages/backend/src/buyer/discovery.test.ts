import { describe, expect, it } from "vitest";
import { fallbackQueries, buyerVocabulary, orGroup, tooNarrow } from "./discovery.js";
import type { IcpProfile } from "./icp.js";

const icp = (over: Partial<IcpProfile> = {}): IcpProfile => ({
  id: "1",
  user_id: "u",
  profile_id: "u",
  product_oneliner: "landing page copywriting for B2B SaaS",
  buyer_description: "early-stage SaaS founders",
  pain_signals: [],
  competitor_terms: [],
  exclusions: [],
  created_at: "",
  updated_at: "",
  ...over,
});

const queriesFor = (over: Partial<IcpProfile> = {}) => {
  const profile = icp(over);
  return fallbackQueries(profile, buyerVocabulary(profile));
};

describe("fallbackQueries (deterministic query composition)", () => {
  it("always covers explicit-ask and trigger-event from the buyer vocabulary", () => {
    const buckets = queriesFor().map((q) => q.bucket);
    expect(buckets).toContain("explicit_ask");
    expect(buckets).toContain("trigger_event");
  });

  it("adds competitor-dissatisfaction queries only when competitors are set", () => {
    expect(queriesFor().some((q) => q.bucket === "competitor_dissatisfaction")).toBe(false);
    const withComp = queriesFor({ competitor_terms: ["mailchimp", "convertkit"] });
    expect(withComp.filter((q) => q.bucket === "competitor_dissatisfaction").length).toBe(2);
    expect(withComp.some((q) => q.q.includes("mailchimp"))).toBe(true);
  });

  it("adds a pain query per pain signal", () => {
    const qs = queriesFor({ pain_signals: ["copy reads like a manual"] });
    expect(qs.some((q) => q.bucket === "pain" && q.q === `"copy reads like a manual"`)).toBe(true);
  });

  it("still searches on the buyer description when there is no product line", () => {
    // Regression: an ICP with only "who buys it" filled in used to produce zero
    // queries, so the radar reported "nobody matched" without searching at all.
    const qs = queriesFor({ product_oneliner: null });
    expect(qs.length).toBeGreaterThan(0);
  });

  it("returns nothing to search when the ICP is entirely empty", () => {
    expect(queriesFor({ product_oneliner: null, buyer_description: null })).toEqual([]);
  });

  // The regression that made the radar return zero prospects for every user: the
  // category was pasted in as a bare word run, and X ANDs bare words, so every
  // query demanded all five of them in one tweet.
  it("never ANDs a run of bare words into a query", () => {
    const cases = [
      "landing page copywriting for B2B SaaS",
      "AI ghostwriter that turns founders' ideas into daily X and LinkedIn posts",
      "a tool that helps busy people plan their meals for the week",
    ];
    for (const product of cases) {
      for (const q of queriesFor({ product_oneliner: product, pain_signals: ["no time to cook"] })) {
        expect(tooNarrow(q.q), `too narrow: ${q.q}`).toBe(false);
      }
    }
  });
});

describe("buyerVocabulary (the keyword-research fallback)", () => {
  it("draws terms from the buyer description as well as the product", () => {
    const vocab = buyerVocabulary(
      icp({ product_oneliner: "AI ghostwriter for founders", buyer_description: "seed-stage SaaS operators" }),
    );
    expect(vocab.some((t) => t.includes("ghostwriter"))).toBe(true);
    expect(vocab.some((t) => t.includes("operators") || t.includes("saas"))).toBe(true);
  });

  it("keeps the user's own pain phrasings — they are already buyer-voiced", () => {
    const vocab = buyerVocabulary(icp({ pain_signals: ["no time to post"] }));
    expect(vocab).toContain("no time to post");
  });

  it("drops sentence filler that would AND itself into a dead query", () => {
    const vocab = buyerVocabulary(icp({ product_oneliner: "a tool that turns your ideas into posts" }));
    expect(vocab).not.toContain("that");
    expect(vocab).not.toContain("turns");
  });
});

describe("orGroup", () => {
  it("builds an OR-group and quotes multi-word terms", () => {
    const group = orGroup(["ai ghostwriter", "ghostwriter", "linkedin"]);
    expect(group.startsWith("(")).toBe(true);
    expect(group).toContain(" OR ");
    expect(group).toContain(`"ai ghostwriter"`);
    expect(tooNarrow(group)).toBe(false);
  });

  it("returns a bare single term rather than a pointless group", () => {
    expect(orGroup(["ghostwriter"])).toBe("ghostwriter");
  });

  it("is empty when there is no vocabulary to search", () => {
    expect(orGroup([])).toBe("");
  });
});

describe("tooNarrow (dead-query guard on distilled queries)", () => {
  it("accepts quoted phrases, OR-groups and operators", () => {
    expect(tooNarrow(`("looking for" OR "recommend") ("ai ghostwriter" OR ghostwriter)`)).toBe(false);
    expect(tooNarrow(`("switching from" OR "alternative to") "Typefully"`)).toBe(false);
    expect(tooNarrow(`"no time to post" lang:en -filter:replies`)).toBe(false);
  });

  it("rejects a query that ANDs a run of bare words", () => {
    expect(tooNarrow(`("looking for" OR "recommend") AI ghostwriter that turns founders`)).toBe(true);
    expect(tooNarrow(`landing page copywriting for B2B SaaS`)).toBe(true);
  });
});
