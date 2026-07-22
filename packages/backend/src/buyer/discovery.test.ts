import { describe, expect, it } from "vitest";
import { fallbackQueries, categoryGroup, tooNarrow } from "./discovery.js";
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

describe("fallbackQueries (deterministic query composition)", () => {
  it("always covers explicit-ask and trigger-event from the product category", () => {
    const qs = fallbackQueries(icp());
    const buckets = qs.map((q) => q.bucket);
    expect(buckets).toContain("explicit_ask");
    expect(buckets).toContain("trigger_event");
  });

  it("adds competitor-dissatisfaction queries only when competitors are set", () => {
    expect(fallbackQueries(icp()).some((q) => q.bucket === "competitor_dissatisfaction")).toBe(false);
    const withComp = fallbackQueries(icp({ competitor_terms: ["mailchimp", "convertkit"] }));
    expect(withComp.filter((q) => q.bucket === "competitor_dissatisfaction").length).toBe(2);
    expect(withComp.some((q) => q.q.includes("mailchimp"))).toBe(true);
  });

  it("adds a pain query per pain signal", () => {
    const qs = fallbackQueries(icp({ pain_signals: ["copy reads like a manual"] }));
    expect(qs.some((q) => q.bucket === "pain" && q.q.includes("copy reads like a manual"))).toBe(true);
  });

  it("returns nothing to search when there is no product to anchor on", () => {
    expect(fallbackQueries(icp({ product_oneliner: null }))).toEqual([]);
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
      for (const q of fallbackQueries(icp({ product_oneliner: product, pain_signals: ["no time to cook"] }))) {
        expect(tooNarrow(q.q), `too narrow: ${q.q}`).toBe(false);
      }
    }
  });

  it("builds the category as an OR-group, not a phrase", () => {
    const group = categoryGroup(icp({ product_oneliner: "AI ghostwriter that turns founders' ideas into posts" }));
    expect(group.startsWith("(")).toBe(true);
    expect(group).toContain(" OR ");
    expect(group).toContain("ghostwriter");
    // Sentence filler must never survive into a search term.
    expect(group).not.toContain("that");
    expect(group).not.toContain("turns");
  });

  it("leaves a pain phrase to stand alone rather than ANDing the category onto it", () => {
    const qs = fallbackQueries(icp({ pain_signals: ["copy reads like a manual"] }));
    const pain = qs.find((q) => q.bucket === "pain")!;
    expect(pain.q).toBe(`"copy reads like a manual"`);
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
