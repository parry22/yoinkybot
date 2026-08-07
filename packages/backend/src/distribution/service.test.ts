import { describe,expect,it } from "vitest";
import { assertFreshConversionTimestamp,isSupportedConversionEvent,recommendedDistributionStepTypes } from "./service.js";

describe("distribution recommendations",()=>{
  it("only recommends a secondary channel when its publisher is connected",()=>{
    expect(recommendedDistributionStepTypes("linkedin_post",["linkedin"])).not.toContain("secondary_channel");
    expect(recommendedDistributionStepTypes("linkedin_post",["linkedin","x"])).toContain("secondary_channel");
  });
  it("keeps non-native formats recommendation-only",()=>{
    expect(recommendedDistributionStepTypes("sales_enablement",["x","linkedin"])).toEqual(["primary_publish","founder_amplification","sales_reuse","resurface"]);
  });
});

describe("conversion event boundaries",()=>{
  it("rejects invented event types",()=>expect(isSupportedConversionEvent("closed_won_by_content")).toBe(false));
  it("accepts the bounded event vocabulary",()=>expect(isSupportedConversionEvent("opportunity")).toBe(true));
  it("rejects invalid, stale and far-future timestamps",()=>{const now=Date.parse("2026-08-06T12:00:00Z");expect(()=>assertFreshConversionTimestamp("not-a-date",now)).toThrow();expect(()=>assertFreshConversionTimestamp("2026-08-04T12:00:00Z",now)).toThrow();expect(()=>assertFreshConversionTimestamp("2026-08-08T12:00:00Z",now)).toThrow();});
  it("accepts a current timestamp",()=>{const now=Date.parse("2026-08-06T12:00:00Z");expect(assertFreshConversionTimestamp("2026-08-06T11:58:00Z",now).toISOString()).toBe("2026-08-06T11:58:00.000Z");});
});
