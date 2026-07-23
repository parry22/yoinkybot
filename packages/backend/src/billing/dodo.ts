import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { track } from "../analytics/posthog.js";
import type { Plan } from "./entitlements.js";

const FOUNDING_CAP = 500;

function apiBase(): string {
  return config.DODO_ENV === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
}

export function planForProduct(productId: string): Plan | undefined {
  if (productId === config.DODO_PRODUCT_FOUNDING) return "founding";
  if (productId === config.DODO_PRODUCT_PAID) return "paid";
  return undefined;
}

export async function foundingSeatsLeft(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM subscriptions WHERE plan = 'founding' AND status IN ('active','on_hold')`,
  );
  return Math.max(0, FOUNDING_CAP - Number(row?.count ?? 0));
}

/**
 * Create a Dodo checkout session for a subscription product. Dodo is the
 * merchant of record, so one integration covers India + international
 * (replaces the PRD's Razorpay + Stripe pair).
 *
 * `opts.trialDays` turns this into a **subscription-with-trial**: the customer
 * enters a card at checkout but isn't charged until the trial ends, when Dodo
 * auto-charges the collected method (`subscription_data.trial_period_days`).
 * Signup uses this (7-day trial → auto-convert to paid). The post-trial upgrade
 * wall calls WITHOUT trialDays, so it charges immediately — a lapsed user can't
 * mint themselves a second free trial.
 */
export async function createCheckout(
  userId: string,
  email: string | null,
  plan: "paid" | "founding",
  opts: { trialDays?: number } = {},
): Promise<{ url: string }> {
  if (!config.DODO_API_KEY) throw new Error("DODO_API_KEY not configured");
  const productId = plan === "founding" ? config.DODO_PRODUCT_FOUNDING : config.DODO_PRODUCT_PAID;
  if (!productId) throw new Error(`Dodo product id for plan "${plan}" not configured`);

  if (plan === "founding" && (await foundingSeatsLeft()) <= 0) {
    throw new Error("Founding cohort is full (500/500)");
  }

  const trial = opts.trialDays && opts.trialDays > 0 ? { trial_period_days: opts.trialDays } : undefined;

  const res = await fetch(`${apiBase()}/checkouts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.DODO_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: email ? { email } : undefined,
      return_url: config.CHECKOUT_RETURN_URL,
      metadata: { user_id: userId, plan },
      ...(trial ? { subscription_data: trial } : {}),
    }),
  });
  if (!res.ok) throw new Error(`dodo checkout failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { checkout_url: string };
  return { url: data.checkout_url };
}

interface DodoSubscriptionEvent {
  type: string;
  data: {
    payload_type?: string;
    subscription_id?: string;
    product_id?: string;
    status?: string;
    next_billing_date?: string;
    customer?: { customer_id?: string; email?: string };
    metadata?: Record<string, string>;
  };
}

const STATUS_BY_EVENT: Record<string, string> = {
  "subscription.active": "active",
  "subscription.renewed": "active",
  "subscription.plan_changed": "active",
  "subscription.on_hold": "on_hold",
  "subscription.failed": "failed",
  "subscription.cancelled": "cancelled",
  "subscription.expired": "expired",
};

/** Apply a verified Dodo webhook event to the subscriptions table. Idempotent. */
export async function handleDodoEvent(event: DodoSubscriptionEvent): Promise<void> {
  const status = STATUS_BY_EVENT[event.type];
  if (!status) return; // payment.* and other events are informational for now

  const d = event.data;
  const userId = d.metadata?.["user_id"];
  const plan = d.product_id ? planForProduct(d.product_id) : undefined;

  if (userId) {
    await query(
      `INSERT INTO subscriptions (user_id, provider, dodo_customer_id, dodo_subscription_id, plan, status, current_period_end, updated_at)
       VALUES ($1, 'dodo', $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         dodo_customer_id = COALESCE(EXCLUDED.dodo_customer_id, subscriptions.dodo_customer_id),
         dodo_subscription_id = COALESCE(EXCLUDED.dodo_subscription_id, subscriptions.dodo_subscription_id),
         plan = COALESCE($4, subscriptions.plan),
         status = EXCLUDED.status,
         current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
         updated_at = now()`,
      [
        userId,
        d.customer?.customer_id ?? null,
        d.subscription_id ?? null,
        plan ?? null,
        status,
        d.next_billing_date ?? null,
      ],
    );
    // Monetization event — only the transition INTO an active subscription,
    // not the informational churn/renewal statuses.
    if (status === "active") track(userId, "subscription_activated", { plan: plan ?? "unknown", provider: "dodo" });
    return;
  }

  // Fallback: correlate by subscription id when metadata is missing (e.g. renewals).
  if (d.subscription_id) {
    await query(
      `UPDATE subscriptions SET status = $2, current_period_end = COALESCE($3, current_period_end), updated_at = now()
       WHERE dodo_subscription_id = $1`,
      [d.subscription_id, status, d.next_billing_date ?? null],
    );
  }
}
