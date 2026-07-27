import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";

// "trialing" is an in-memory plan LABEL for a user inside their 7-day free trial
// — it maps to the full paid feature set. It is never written to
// subscriptions.plan (whose CHECK is free/paid/founding); the trial is stored as
// status='trialing' + trial_ends_at. See startTrial / trialInfo below.
export type Plan = "free" | "trialing" | "paid" | "scale" | "founding";

export interface Entitlements {
  plan: Plan;
  // ── Numeric caps. `null` means UNLIMITED (JSON-safe, and the type forces every
  //    call site to handle the unlimited branch — unlike Infinity/-1). Use
  //    withinCap()/remainingFor() below so the null case is handled identically. ──
  /** Posts a user may schedule per calendar month. */
  scheduledPostsPerMonth: number | null;
  /** Buyer-radar intent signals surfaced per calendar month. */
  buyerIntentsPerMonth: number | null;
  /** Viral-tweet breakdowns delivered per day. */
  viralPerDay: number | null;
  /** Auto Agent posts across ALL of a user's automations per calendar month. */
  automationPostsPerMonth: number | null;
  // NOTE: `trendsPerDay` used to live here. It was identical on every paid tier
  // (config.MAX_DAILY_TREND_SENDS) and read by nothing — the trend sender caps
  // itself off config directly — so it was a documented promise no code kept.
  // Removed rather than enforced: it isn't a plan differentiator.
  /** Hard cap on proactive resurfacings per week. */
  maxResurfacePerWeek: number;
  // ── Feature flags ──
  /** Hands-off AUTO automation delivery ("posts on its own") — Scale only. */
  autoAgent: boolean;
  consistencyChecks: boolean;
  voiceProfile: boolean;
  drafting: boolean;
  macroMatching: boolean;
}

/** true while `used` is still under `cap`; a null cap (unlimited) is always within. */
export function withinCap(used: number, cap: number | null): boolean {
  return cap === null || used < cap;
}

/** Remaining headroom under `cap`, or null when the cap is unlimited. */
export function remainingFor(used: number, cap: number | null): number | null {
  return cap === null ? null : Math.max(0, cap - used);
}

const FREE: Entitlements = {
  plan: "free",
  scheduledPostsPerMonth: 0,
  buyerIntentsPerMonth: 0,
  viralPerDay: 0,
  automationPostsPerMonth: 0,
  maxResurfacePerWeek: 1,
  autoAgent: false,
  consistencyChecks: false,
  voiceProfile: false,
  drafting: false,
  macroMatching: false,
};

// Growth (the 'paid' plan): the entry paid tier — real caps, no hands-off agent.
const GROWTH: Omit<Entitlements, "plan"> = {
  scheduledPostsPerMonth: 30,
  buyerIntentsPerMonth: 25,
  viralPerDay: 1,
  // Auto Agent runs in APPROVAL mode on Growth (autoAgent below gates hands-off
  // posting, which stays Scale-only) — so this is 5 agent-written posts a month
  // that still come to you first.
  automationPostsPerMonth: 5,
  maxResurfacePerWeek: 3,
  autoAgent: false,
  consistencyChecks: true,
  voiceProfile: true,
  drafting: true,
  macroMatching: true,
};

// Scale (the 'scale'/'founding' plan, and the trial): the high-ceiling tier plus
// the hands-off auto agent. `null` = unlimited.
const SCALE: Omit<Entitlements, "plan"> = {
  scheduledPostsPerMonth: null,
  // 300/month, NOT unlimited. Every buyer lead is a paid twitterapi.io search
  // plus an embedding, billed per user rather than shared across the fleet like
  // trends — so "unlimited" was a promise the unit economics could not keep, and
  // the UI showed an ∞ that nothing enforced. 300 is ~50 scans of six leads a
  // month, far past what anyone works through, and it is a real number the
  // screen can count down.
  buyerIntentsPerMonth: 300,
  viralPerDay: null,
  // 90/month ≈ 3 a day: a real hands-off cadence, but still a hard ceiling so a
  // runaway automation can't post unbounded. Not `null` on purpose.
  automationPostsPerMonth: 90,
  maxResurfacePerWeek: 5,
  autoAgent: true,
  consistencyChecks: true,
  voiceProfile: true,
  drafting: true,
  macroMatching: true,
};

/**
 * Telegram ids that bypass the paywall: PAYWALL_WHITELIST (comma-separated) plus
 * ADMIN_TELEGRAM_ID, which is always exempt so the operator never has to upgrade
 * their own account to use the product.
 */
export function whitelistIncludes(
  telegramId: string | null | undefined,
  whitelistCsv: string | undefined,
  adminId: string | undefined,
): boolean {
  if (!telegramId) return false;
  const ids = new Set<string>();
  for (const raw of (whitelistCsv ?? "").split(",")) {
    const t = raw.trim();
    if (t) ids.add(t);
  }
  if (adminId) ids.add(adminId.trim());
  return ids.has(String(telegramId).trim());
}

export function isWhitelisted(telegramId: string | null | undefined): boolean {
  return whitelistIncludes(telegramId, config.PAYWALL_WHITELIST, config.ADMIN_TELEGRAM_ID);
}

/**
 * The single "is this user allowed past the post-diagnosis paywall" check.
 * True when the paywall is off entirely (testing), the user is whitelisted, or
 * they actually hold a paid/founding plan. Used by the upgrade wall so LLM/API
 * work stays blocked for free users after their diagnosis lands.
 */
export async function isPaidOrExempt(user: { id: string; telegram_id: string | null }): Promise<boolean> {
  if (!config.PAYWALL_ENABLED) return true;
  if (isWhitelisted(user.telegram_id)) return true;
  const ent = await entitlementsFor(user.id);
  return ent.plan !== "free";
}

/**
 * Map a plan label to its entitlement caps. Growth ('paid') is the entry tier;
 * Scale ('scale'), Founding, and the trial get the full uncapped set. Exported
 * for unit tests — the pure heart of the plan differentiation.
 */
export function entitlementsForPlan(plan: Plan): Entitlements {
  switch (plan) {
    case "scale":
    case "founding":
      return { plan, ...SCALE };
    case "paid":
      return { plan, ...GROWTH };
    // A trial runs at the ENTRY tier. This case is defensive — `entitlementsFor`
    // routes trials through `trialCaps` and only ever passes a real DB `plan`
    // here — but it used to answer SCALE, which would have quietly reopened the
    // free-Scale-trial hole for any future caller. One rule, one answer.
    case "trialing":
      return { plan, ...GROWTH };
    default:
      return FREE;
  }
}

/**
 * Days of continued access after a payment fails and Dodo moves the
 * subscription to `on_hold`. Dodo keeps dunning the card during this window, so
 * the overwhelmingly common outcome is "the retry succeeds and the customer
 * never noticed". Cutting a paying customer off the instant the first charge
 * bounces (the old behaviour) turned a bank hiccup into an outage.
 */
export const ON_HOLD_GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subscription columns the state resolver needs. Shaped like the DB row. */
export interface SubscriptionRow {
  plan: Plan;
  status: string;
  trial_ends_at: string | Date | null;
  /** Paid-through date from Dodo (`next_billing_date`). Drives both grace windows. */
  current_period_end: string | Date | null;
  /** When we last wrote this row — the best available proxy for "hold started". */
  updated_at: string | Date | null;
  intended_plan: string | null;
  /** Present once Dodo has ever told us about a real subscription for this user. */
  dodo_subscription_id: string | null;
}

/**
 * What the billing row means right now, in the vocabulary the UI actually needs.
 *
 * The distinction that matters: `expired` is "a free trial lapsed and they never
 * paid", `past_due` is "a paying customer's card bounced", `cancelled` is "a real
 * subscription is winding down or over". These used to collapse into one
 * `expired` bucket, which is how a customer who had been paying for months got
 * told "Your free trial has ended".
 */
export type BillingState = "none" | "trialing" | "active" | "past_due" | "cancelled" | "expired";

export interface AccessDecision {
  state: BillingState;
  /** True when the user should get paid-tier entitlements right now. */
  entitled: boolean;
  /**
   * Epoch ms at which time-limited access runs out — the on_hold grace deadline
   * or the paid-through date of a cancelled plan. Null when access is either
   * open-ended (active/trialing) or already gone.
   */
  accessUntil: number | null;
}

function ms(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Resolve a subscription row into "what state is this and do they get in".
 * Pure and exported so entitlementsFor (access) and trialInfo (copy) can never
 * disagree about the same row — the bug where Settings said "trial ended" to a
 * customer who still had entitlements was exactly that disagreement.
 */
export function resolveBillingState(sub: SubscriptionRow | undefined | null, now: number): AccessDecision {
  if (!sub) return { state: "none", entitled: false, accessUntil: null };

  const trialEnds = ms(sub.trial_ends_at);
  const periodEnd = ms(sub.current_period_end);
  const everSubscribed = Boolean(sub.dodo_subscription_id) || periodEnd !== null;
  // A 'free' plan can never be entitled no matter what the status says.
  const paidPlan = sub.plan !== "free";

  switch (sub.status) {
    case "trialing":
      if (trialEnds && trialEnds > now) return { state: "trialing", entitled: true, accessUntil: trialEnds };
      // Trial clock ran out. If they later became a real subscriber the status
      // would have moved on, so this is the plain lapsed-trialist.
      return { state: everSubscribed ? "cancelled" : "expired", entitled: false, accessUntil: null };

    case "active":
      return paidPlan
        ? { state: "active", entitled: true, accessUntil: null }
        : { state: "expired", entitled: false, accessUntil: null };

    case "on_hold":
    case "failed": {
      // Payment problem on a live subscription. Grace runs from the paid-through
      // date when we have one (the renewal that bounced), otherwise from when the
      // hold landed. current_period_end had been written by the webhook and read
      // by nothing until this line.
      const graceFrom = periodEnd ?? ms(sub.updated_at) ?? now;
      const graceUntil = graceFrom + ON_HOLD_GRACE_DAYS * DAY_MS;
      const inGrace = paidPlan && now < graceUntil;
      // Still `past_due` after the grace window closes: the reason they lost
      // access is a failed payment, and telling them that is what gets the card
      // updated. It is never a "trial ended" message.
      return { state: "past_due", entitled: inGrace, accessUntil: inGrace ? graceUntil : null };
    }

    case "cancelled": {
      // Cancelling is "don't renew me", not "cut me off mid-month" — they have
      // paid through current_period_end. Killing access instantly was both wrong
      // and the kind of thing that gets charged back.
      const stillPaidFor = paidPlan && periodEnd !== null && periodEnd > now;
      return { state: "cancelled", entitled: stillPaidFor, accessUntil: stillPaidFor ? periodEnd : null };
    }

    case "refunded":
    case "disputed":
      // Money went back to the customer. No grace, no paid-through — revoke now.
      return { state: "cancelled", entitled: false, accessUntil: null };

    case "expired":
      return { state: everSubscribed ? "cancelled" : "expired", entitled: false, accessUntil: null };

    default:
      // 'none' and anything a future Dodo status introduces: fail closed, but
      // don't mislabel a former subscriber as a lapsed trialist.
      if (everSubscribed) return { state: "cancelled", entitled: false, accessUntil: null };
      return { state: trialEnds ? "expired" : "none", entitled: false, accessUntil: null };
  }
}

/**
 * The caps a trial runs at: **always Growth, the entry tier.**
 *
 * This used to follow `subscriptions.intended_plan`, so a Scale/Founding signup
 * trialled at Scale caps. The problem is where `intended_plan` comes from: a
 * `?plan=` query param on the landing CTA, recorded with no payment signal of
 * any kind. So ANY signed-in user could visit `/app?plan=scale` and hand
 * themselves, free for 7 days, 300 paid twitterapi.io buyer searches instead of
 * 25, unlimited virals instead of 1/day, 90 agent posts instead of 5, and
 * `autoAgent: true` — hands-off posting with no card on file. The trial was
 * effectively Scale for anyone who edited a URL.
 *
 * The rule now: **`intended_plan` decides what we SHOW, never what we GRANT.**
 * It is still recorded and still drives which product Settings preselects and
 * which plan the upgrade CTA points at (`purchasablePlanParam`), so someone who
 * came in on the Scale CTA still sees Scale as the thing they're about to buy —
 * they just trial the entry tier until a real payment lands, at which point
 * `entitlementsForPlan(sub.plan)` takes over with the plan they actually hold.
 *
 * The parameter is kept for call-site clarity (and so the reasoning above sits
 * next to the value it deliberately ignores).
 */
function trialCaps(_intendedPlan: string | null | undefined): Omit<Entitlements, "plan"> {
  return GROWTH;
}

/** The columns every billing read needs. One list so the shapes can't drift. */
const SUB_COLUMNS = `plan, status, trial_ends_at, current_period_end, updated_at, intended_plan, dodo_subscription_id`;

export async function entitlementsFor(userId: string): Promise<Entitlements> {
  const sub = await queryOne<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  const access = resolveBillingState(sub, Date.now());
  const trialing = access.state === "trialing";

  // Paywall off during testing (PAYWALL_ENABLED=false): grant the caps of the
  // plan the user is on/chose so local caps mirror production, but report the
  // true plan label so UI/telemetry still reflect trial vs paid vs free.
  if (!config.PAYWALL_ENABLED) {
    if (trialing) return { plan: "trialing", ...trialCaps(sub!.intended_plan) };
    if (access.entitled) return entitlementsForPlan(sub!.plan);
    return { plan: sub?.plan ?? "free", ...SCALE };
  }

  // The trial runs at the caps of the plan the user picked — not a blanket Scale
  // grant — so the limits shown everywhere match the plan Settings marks current.
  if (trialing) return { plan: "trialing", ...trialCaps(sub!.intended_plan) };
  // `entitled` now also covers the on_hold grace window and a cancelled plan
  // that is still inside its paid period, at the caps of the plan they hold.
  if (access.entitled) return entitlementsForPlan(sub!.plan);
  return FREE;
}

/**
 * Start a user's 7-day free trial (TRIAL_DAYS). Idempotent: a user who already
 * has a subscription row — trialing, paid, or lapsed — is left untouched, so
 * this never resets a clock or revives an expired trial. Called once, when the
 * account is first created (lib/auth.findOrCreateUserByClerkId).
 */
export async function startTrial(userId: string, intendedPlan?: string | null): Promise<void> {
  await query(
    `INSERT INTO subscriptions (user_id, provider, plan, status, trial_ends_at, intended_plan, updated_at)
     VALUES ($1, 'dodo', 'paid', 'trialing', now() + make_interval(days => $2::int), $3, now())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, config.TRIAL_DAYS, intendedPlan ?? null],
  );
}

/** The only values the landing CTAs ever send, and the only ones we'll store. */
const INTENDED_PLANS = new Set(["growth", "scale", "founding"]);

/**
 * Record the plan the user picked on the landing page (growth/scale/founding),
 * captured from the `?plan=` param at sign-up. Only fills an empty slot, so the
 * first choice sticks and a later visit with a different param can't clobber it.
 */
export async function setIntendedPlan(userId: string, plan: string): Promise<void> {
  // Whitelist, don't sanitize. This lands in a column that Settings and the
  // upgrade CTA read back, and it arrives from a query param, so anything
  // outside the three real landing plans is junk we'd be storing and later
  // rendering. (It no longer grants entitlements — see `trialCaps` — but a
  // value that can't be junk is one less thing to reason about.)
  const clean = plan.trim().toLowerCase();
  if (!INTENDED_PLANS.has(clean)) return;
  await query(
    `UPDATE subscriptions SET intended_plan = $2, updated_at = now()
     WHERE user_id = $1 AND intended_plan IS NULL`,
    [userId, clean],
  );
}

export interface TrialInfo {
  /**
   * trialing = inside the trial window; active = paying; past_due = a PAYING
   * customer whose card failed (never a trial message); cancelled = a real
   * subscription winding down or over; expired = trial lapsed and they never
   * paid; none = no row yet.
   */
  status: BillingState;
  /** True only while an unexpired trial is running. */
  onTrial: boolean;
  /** Whole days left in the trial, 0 once it has ended (the "cleared" state). */
  daysLeft: number;
  endsAt: string | null;
  plan: Plan;
  /** The plan the user picked on the landing page at sign-up, if any. */
  intendedPlan: string | null;
  /**
   * True while the user still has paid-tier access. Distinct from `status`:
   * a `past_due` user inside the grace window, or a `cancelled` one still
   * inside their paid period, is not "active" but is very much still let in.
   */
  hasAccess: boolean;
  /** ISO date when time-limited (grace / paid-through) access ends, else null. */
  accessUntil: string | null;
  /**
   * The `?plan=` value an upgrade CTA may safely link to: the plan picked at
   * signup, but ONLY when that plan's Dodo product is configured. Founding was
   * a permanent dead end for anyone who arrived from a founding link —
   * DODO_PRODUCT_FOUNDING is unset, so every checkout throw threw and the CTA
   * could never be completed. Null means "just use the default Growth product".
   */
  purchasablePlan: string | null;
}

export interface BillingOverview {
  trial: TrialInfo;
  /** A Dodo subscription is on file (card captured) → offer the manage/cancel portal. */
  hasDodoSubscription: boolean;
  /** The Dodo customer id (needed to open the customer portal), if any. */
  dodoCustomerId: string | null;
}

/**
 * Everything the Settings → Billing section needs: the trial/plan state plus
 * whether a Dodo subscription exists (so we show "Manage plan" via the customer
 * portal) or not (so we show "Add payment" / "Upgrade" checkout instead).
 */
export async function billingOverview(userId: string): Promise<BillingOverview> {
  const sub = await queryOne<{ dodo_subscription_id: string | null; dodo_customer_id: string | null }>(
    `SELECT dodo_subscription_id, dodo_customer_id FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  const trial = await trialInfo(userId);
  return {
    trial,
    hasDodoSubscription: Boolean(sub?.dodo_subscription_id),
    dodoCustomerId: sub?.dodo_customer_id ?? null,
  };
}

/**
 * Which landing plan an upgrade CTA can actually link to. A plan whose Dodo
 * product id is unset can't be bought, so pointing a user at it is a dead end;
 * null tells the caller to fall back to the default Growth product.
 *
 * Deliberately config-only — no founding SEAT check here, because trialInfo runs
 * on every app page render and a live seat count is a DB round trip per render.
 * A full cohort is handled at checkout (createCheckout downgrades to Growth).
 */
function purchasablePlanParam(intendedPlan: string | null): string | null {
  const i = (intendedPlan ?? "").trim().toLowerCase();
  if (i === "founding") return config.DODO_PRODUCT_FOUNDING ? "founding" : null;
  if (i === "scale") return config.DODO_PRODUCT_SCALE ? "scale" : null;
  // "growth" (and anything else) resolves to the default paid product anyway,
  // so there is nothing to preserve in the query string.
  return null;
}

/** The trial/subscription state for a user, for the web banner + Telegram copy. */
export async function trialInfo(userId: string): Promise<TrialInfo> {
  const sub = await queryOne<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  const now = Date.now();
  const access = resolveBillingState(sub, now);

  if (!sub) {
    return {
      status: "none", onTrial: false, daysLeft: 0, endsAt: null, plan: "free",
      intendedPlan: null, hasAccess: false, accessUntil: null, purchasablePlan: null,
    };
  }

  const trialEndsIso = sub.trial_ends_at ? new Date(sub.trial_ends_at).toISOString() : null;
  const onTrial = access.state === "trialing";
  const ends = onTrial ? (access.accessUntil ?? 0) : 0;
  const daysLeft = onTrial ? Math.max(0, Math.ceil((ends - now) / (24 * 60 * 60 * 1000))) : 0;

  // The plan label follows the money, not the status: a past_due or winding-down
  // customer is still a Growth/Scale customer and the UI should say so. Only a
  // genuinely unpaid state reports "free".
  const plan: Plan = onTrial
    ? "trialing"
    : access.state === "expired" || access.state === "none"
      ? "free"
      : sub.plan;

  return {
    status: access.state,
    onTrial,
    daysLeft,
    endsAt: trialEndsIso,
    plan,
    intendedPlan: sub.intended_plan,
    hasAccess: access.entitled,
    accessUntil: access.accessUntil ? new Date(access.accessUntil).toISOString() : null,
    purchasablePlan: purchasablePlanParam(sub.intended_plan),
  };
}
