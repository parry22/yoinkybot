import { describe, expect, it } from "vitest";
import { fallbackQueries } from "./discovery.js";
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
});
