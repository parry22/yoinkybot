import { describe, expect, it } from "vitest";
import { whitelistIncludes, entitlementsForPlan, withinCap, remainingFor } from "./entitlements.js";

describe("entitlementsForPlan (Growth vs Scale differentiation)", () => {
  it("free gets nothing", () => {
    const e = entitlementsForPlan("free");
    expect(e.scheduledPostsPerMonth).toBe(0);
    expect(e.buyerIntentsPerMonth).toBe(0);
    expect(e.viralPerDay).toBe(0);
    expect(e.autoAgent).toBe(false);
    expect(e.drafting).toBe(false);
    expect(e.maxResurfacePerWeek).toBe(1);
  });

  it("Growth ('paid') has real caps and NO auto-agent", () => {
    const e = entitlementsForPlan("paid");
    expect(e.plan).toBe("paid");
    expect(e.scheduledPostsPerMonth).toBe(30);
    expect(e.buyerIntentsPerMonth).toBe(25);
    expect(e.viralPerDay).toBe(1);
    expect(e.automationPostsPerMonth).toBe(5);
    expect(e.autoAgent).toBe(false);
    expect(e.maxResurfacePerWeek).toBe(3);
    expect(e.drafting).toBe(true);
  });

  it("Scale is high-ceiling with auto-agent on", () => {
    const e = entitlementsForPlan("scale");
    expect(e.plan).toBe("scale");
    expect(e.scheduledPostsPerMonth).toBeNull();
    expect(e.viralPerDay).toBeNull();
    expect(e.autoAgent).toBe(true);
    // The two deliberate exceptions to "Scale = unlimited", both because the
    // work behind them is metered per-user rather than shared: a hands-off
    // poster needs a ceiling so a runaway can't post unbounded, and every buyer
    // lead is a paid X search plus an embedding.
    expect(e.automationPostsPerMonth).toBe(90);
    expect(e.buyerIntentsPerMonth).toBe(300);
    expect(e.maxResurfacePerWeek).toBe(5);
  });

  it("founding and trialing map to the full Scale set", () => {
    for (const plan of ["founding", "trialing"] as const) {
      const e = entitlementsForPlan(plan);
      expect(e.autoAgent).toBe(true);
      expect(e.scheduledPostsPerMonth).toBeNull();
      expect(e.buyerIntentsPerMonth).toBe(300);
    }
  });
});

describe("withinCap / remainingFor (null = unlimited)", () => {
  it("a null cap is always within and has null remaining", () => {
    expect(withinCap(9999, null)).toBe(true);
    expect(remainingFor(9999, null)).toBeNull();
  });
  it("respects a numeric cap", () => {
    expect(withinCap(4, 5)).toBe(true);
    expect(withinCap(5, 5)).toBe(false);
    expect(withinCap(0, 0)).toBe(false);
    expect(remainingFor(3, 10)).toBe(7);
    expect(remainingFor(12, 10)).toBe(0);
  });
});

describe("whitelistIncludes", () => {
  it("exempts the admin id even when the whitelist is empty", () => {
    expect(whitelistIncludes("123", undefined, "123")).toBe(true);
    expect(whitelistIncludes("123", "", "123")).toBe(true);
  });

  it("exempts any id listed in the comma-separated whitelist", () => {
    expect(whitelistIncludes("456", "111, 456 ,789", undefined)).toBe(true);
    expect(whitelistIncludes("789", "111,456,789", "999")).toBe(true);
  });

  it("does not exempt an id that is neither admin nor whitelisted", () => {
    expect(whitelistIncludes("222", "111,333", "999")).toBe(false);
  });

  it("returns false for a missing telegram id", () => {
    expect(whitelistIncludes(null, "111", "999")).toBe(false);
    expect(whitelistIncludes(undefined, "111", "999")).toBe(false);
  });

  it("tolerates whitespace and matches on exact id, not substring", () => {
    expect(whitelistIncludes(" 123 ", " 123 ", undefined)).toBe(true);
    expect(whitelistIncludes("12", "123", undefined)).toBe(false); // no substring match
  });
});
