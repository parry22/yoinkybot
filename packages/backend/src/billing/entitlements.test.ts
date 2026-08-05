import { describe, expect, it } from "vitest";
import {
  whitelistIncludes,
  entitlementsForPlan,
  withinCap,
  remainingFor,
  resolveBillingState,
  ON_HOLD_GRACE_DAYS,
  type SubscriptionRow,
} from "./entitlements.js";

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

  it("founding maps to the full Scale set", () => {
    const e = entitlementsForPlan("founding");
    expect(e.autoAgent).toBe(true);
    expect(e.scheduledPostsPerMonth).toBeNull();
    expect(e.buyerIntentsPerMonth).toBe(300);
  });

  /**
   * A trial runs at the ENTRY tier, never Scale. `intended_plan` — the only
   * thing that used to lift a trial to Scale caps — comes from a `?plan=` URL
   * param with no payment signal, so `/app?plan=scale` was a free 7-day grant of
   * 300 paid buyer searches, unlimited virals and hands-off auto-posting.
   * `trialCaps` returns GROWTH unconditionally now; this asserts the defensive
   * `entitlementsForPlan` path agrees, so the hole can't reopen from the side.
   */
  it("a trial is Growth-capped, and specifically never gets hands-off posting", () => {
    const e = entitlementsForPlan("trialing");
    expect(e.autoAgent).toBe(false);
    expect(e.scheduledPostsPerMonth).toBe(30);
    expect(e.buyerIntentsPerMonth).toBe(25);
    expect(e.automationPostsPerMonth).toBe(5);
    expect(e.viralPerDay).toBe(1);
  });
});

describe("retired lifetime compatibility", () => {
  it("maps old rows to Scale caps until migration 0041 runs", () => {
    const e = entitlementsForPlan("lifetime");
    expect(e.scheduledPostsPerMonth).toBeNull();
    expect(e.buyerIntentsPerMonth).toBe(300);
    expect(e.viralPerDay).toBeNull();
    expect(e.automationPostsPerMonth).toBe(90);
    expect(e.autoAgent).toBe(true);
    expect(e.maxResurfacePerWeek).toBe(5);
  });

  /**
   * The whole subscription state machine reasons about renewals, paid-through
   * dates and dunning. A lifetime purchase has none of those, so a stray
   * subscription event must never be able to revoke it — that would take access
   * from someone who paid once and owns it forever.
   */
  const lifetimeRow = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    plan: "lifetime",
    status: "active",
    trial_ends_at: null,
    current_period_end: null,
    updated_at: null,
    intended_plan: null,
    dodo_subscription_id: null,
    ...over,
  });

  it("stays entitled with no period end and no subscription id", () => {
    const d = resolveBillingState(lifetimeRow(), Date.now());
    expect(d).toEqual({ state: "active", entitled: true, accessUntil: null });
  });

  it("survives stray subscription lifecycle events", () => {
    for (const status of ["cancelled", "expired", "on_hold", "failed", "trialing"]) {
      const d = resolveBillingState(lifetimeRow({ status }), Date.now());
      expect(d.entitled, `status=${status} must not revoke a lifetime plan`).toBe(true);
    }
  });

  it("IS revoked when the money goes back", () => {
    for (const status of ["refunded", "disputed"]) {
      expect(resolveBillingState(lifetimeRow({ status }), Date.now()).entitled).toBe(false);
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

describe("resolveBillingState (grace windows + honest labels)", () => {
  const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (t: number) => new Date(t).toISOString();

  function row(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
    return {
      plan: "paid",
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
      updated_at: iso(NOW),
      intended_plan: null,
      dodo_subscription_id: "sub_1",
      ...over,
    };
  }

  it("no row at all is 'none' and gets nothing", () => {
    expect(resolveBillingState(undefined, NOW)).toEqual({ state: "none", entitled: false, accessUntil: null });
  });

  it("an active paid subscription is entitled with no deadline", () => {
    expect(resolveBillingState(row(), NOW)).toEqual({ state: "active", entitled: true, accessUntil: null });
  });

  it("an 'active' row still on the free plan is never entitled", () => {
    expect(resolveBillingState(row({ plan: "free" }), NOW).entitled).toBe(false);
  });

  it("a running trial is entitled until trial_ends_at", () => {
    const d = resolveBillingState(row({ status: "trialing", trial_ends_at: iso(NOW + 3 * DAY) }), NOW);
    expect(d).toEqual({ state: "trialing", entitled: true, accessUntil: NOW + 3 * DAY });
  });

  it("a lapsed trial with no subscription is 'expired' (the real trialist)", () => {
    const d = resolveBillingState(
      row({ status: "trialing", trial_ends_at: iso(NOW - DAY), dodo_subscription_id: null }),
      NOW,
    );
    expect(d).toEqual({ state: "expired", entitled: false, accessUntil: null });
  });

  // The headline bug: a paying customer whose card bounced was cut off instantly
  // AND told their free trial had ended.
  describe("on_hold", () => {
    it("keeps access through the grace window measured from the paid-through date", () => {
      const periodEnd = NOW - DAY; // the renewal that bounced
      const d = resolveBillingState(row({ status: "on_hold", current_period_end: iso(periodEnd) }), NOW);
      expect(d.state).toBe("past_due");
      expect(d.entitled).toBe(true);
      expect(d.accessUntil).toBe(periodEnd + ON_HOLD_GRACE_DAYS * DAY);
    });

    it("revokes once the grace window closes — but still reads as past_due, never a trial", () => {
      const periodEnd = NOW - (ON_HOLD_GRACE_DAYS + 1) * DAY;
      const d = resolveBillingState(row({ status: "on_hold", current_period_end: iso(periodEnd) }), NOW);
      expect(d.state).toBe("past_due");
      expect(d.entitled).toBe(false);
      expect(d.accessUntil).toBeNull();
    });

    it("falls back to when the hold landed when there is no period end", () => {
      const held = NOW - DAY;
      const d = resolveBillingState(row({ status: "on_hold", current_period_end: null, updated_at: iso(held) }), NOW);
      expect(d.entitled).toBe(true);
      expect(d.accessUntil).toBe(held + ON_HOLD_GRACE_DAYS * DAY);
    });

    it("never grants grace to a free-plan row", () => {
      const d = resolveBillingState(row({ status: "on_hold", plan: "free", current_period_end: iso(NOW) }), NOW);
      expect(d.entitled).toBe(false);
    });
  });

  describe("cancelled", () => {
    it("keeps access until the period they already paid for runs out", () => {
      const periodEnd = NOW + 10 * DAY;
      const d = resolveBillingState(row({ status: "cancelled", current_period_end: iso(periodEnd) }), NOW);
      expect(d).toEqual({ state: "cancelled", entitled: true, accessUntil: periodEnd });
    });

    it("revokes once that period has passed", () => {
      const d = resolveBillingState(row({ status: "cancelled", current_period_end: iso(NOW - DAY) }), NOW);
      expect(d).toEqual({ state: "cancelled", entitled: false, accessUntil: null });
    });

    it("revokes immediately when we never learned a period end", () => {
      expect(resolveBillingState(row({ status: "cancelled", current_period_end: null }), NOW).entitled).toBe(false);
    });
  });

  it("refunds and lost disputes revoke immediately — no grace, no paid-through", () => {
    for (const status of ["refunded", "disputed"]) {
      // Even with a period end well in the future: the money went back.
      const d = resolveBillingState(row({ status, current_period_end: iso(NOW + 30 * DAY) }), NOW);
      expect(d).toEqual({ state: "cancelled", entitled: false, accessUntil: null });
    }
  });

  it("a former subscriber is never labelled a lapsed trialist", () => {
    // 'expired' with a subscription on file → "your plan ended", not "your trial ended".
    expect(resolveBillingState(row({ status: "expired" }), NOW).state).toBe("cancelled");
    expect(resolveBillingState(row({ status: "expired", dodo_subscription_id: null }), NOW).state).toBe("expired");
  });

  it("an unknown future status fails closed", () => {
    expect(resolveBillingState(row({ status: "some_new_dodo_status" }), NOW).entitled).toBe(false);
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
