import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";

// "trialing" is an in-memory plan LABEL for a user inside their 7-day free trial
// — it maps to the full paid feature set. It is never written to
// subscriptions.plan (whose CHECK is free/paid/founding); the trial is stored as
// status='trialing' + trial_ends_at. See startTrial / trialInfo below.
export type Plan = "free" | "trialing" | "paid" | "scale" | "founding";

export interface Entitlements {
  plan: Plan;
  /** Hard cap on proactive resurfacings per week. */
  maxResurfacePerWeek: number;
  consistencyChecks: boolean;
  voiceProfile: boolean;
  drafting: boolean;
  macroMatching: boolean;
}

const FREE: Entitlements = {
  plan: "free",
  maxResurfacePerWeek: 1,
  consistencyChecks: false,
  voiceProfile: false,
  drafting: false,
  macroMatching: false,
};

const PAID: Omit<Entitlements, "plan"> = {
  maxResurfacePerWeek: 3,
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

export async function entitlementsFor(userId: string): Promise<Entitlements> {
  const sub = await queryOne<{ plan: Plan; status: string; trial_ends_at: string | null }>(
    `SELECT plan, status, trial_ends_at FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  const trialing =
    !!sub && sub.status === "trialing" && !!sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() > Date.now();
  const paid = !!sub && sub.status === "active" && sub.plan !== "free";

  // Paywall is off during testing (PAYWALL_ENABLED=false) — everyone gets the
  // full feature set. Flip the flag on to enforce plans; the logic below is ready.
  // We still report the true plan label so the UI/telemetry reflect trial vs paid.
  if (!config.PAYWALL_ENABLED) {
    const plan: Plan = trialing ? "trialing" : (sub?.plan ?? "free");
    return { plan, ...PAID };
  }

  if (trialing) return { plan: "trialing", ...PAID };
  if (paid) return { plan: sub!.plan, ...PAID };
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

/**
 * Record the plan the user picked on the landing page (growth/scale/founding),
 * captured from the `?plan=` param at sign-up. Only fills an empty slot, so the
 * first choice sticks and a later visit with a different param can't clobber it.
 */
export async function setIntendedPlan(userId: string, plan: string): Promise<void> {
  const clean = plan.trim().slice(0, 40);
  if (!clean) return;
  await query(
    `UPDATE subscriptions SET intended_plan = $2, updated_at = now()
     WHERE user_id = $1 AND intended_plan IS NULL`,
    [userId, clean],
  );
}

export interface TrialInfo {
  /** trialing = inside the trial window; active = paying; expired = trial lapsed, unpaid; none = no row yet. */
  status: "trialing" | "active" | "expired" | "none";
  /** True only while an unexpired trial is running. */
  onTrial: boolean;
  /** Whole days left in the trial, 0 once it has ended (the "cleared" state). */
  daysLeft: number;
  endsAt: string | null;
  plan: Plan;
  /** The plan the user picked on the landing page at sign-up, if any. */
  intendedPlan: string | null;
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

/** The trial/subscription state for a user, for the web banner + Telegram copy. */
export async function trialInfo(userId: string): Promise<TrialInfo> {
  const sub = await queryOne<{ plan: Plan; status: string; trial_ends_at: string | null; intended_plan: string | null }>(
    `SELECT plan, status, trial_ends_at, intended_plan FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  if (!sub) return { status: "none", onTrial: false, daysLeft: 0, endsAt: null, plan: "free", intendedPlan: null };
  if (sub.status === "active" && sub.plan !== "free") {
    return { status: "active", onTrial: false, daysLeft: 0, endsAt: null, plan: sub.plan, intendedPlan: sub.intended_plan };
  }
  const ends = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : 0;
  const now = Date.now();
  if (sub.status === "trialing" && ends > now) {
    const daysLeft = Math.max(0, Math.ceil((ends - now) / (24 * 60 * 60 * 1000)));
    return { status: "trialing", onTrial: true, daysLeft, endsAt: sub.trial_ends_at, plan: "trialing", intendedPlan: sub.intended_plan };
  }
  // Trial started but has lapsed (or the sub is otherwise inactive): the trial is
  // over and the day count is cleared to 0 — the upgrade wall now applies.
  return { status: "expired", onTrial: false, daysLeft: 0, endsAt: sub.trial_ends_at, plan: "free", intendedPlan: sub.intended_plan };
}
