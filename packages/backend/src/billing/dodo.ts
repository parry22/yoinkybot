import { config } from "../config.js";
import { queryOne, withTransaction } from "../db/pool.js";
import { track } from "../analytics/posthog.js";
import { alertAdmin } from "../lib/alerts.js";
import type { Plan } from "./entitlements.js";

/** Founding cohort size. Must match the landing page's "first 50 users" line —
 *  the seat counter in the Telegram upgrade offer is derived from this. */
const FOUNDING_CAP = 50;

function apiBase(): string {
  return config.DODO_ENV === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
}

/** Plan → the configured Dodo product id for it (undefined when unconfigured). */
function productIdFor(plan: "paid" | "scale" | "founding"): string | undefined {
  return plan === "founding"
    ? config.DODO_PRODUCT_FOUNDING
    : plan === "scale"
      ? config.DODO_PRODUCT_SCALE
      : config.DODO_PRODUCT_PAID;
}

/**
 * Validate the three DODO_PRODUCT_* ids once and alert loudly if they collide.
 *
 * planForProduct maps id → plan by comparing against each config value in order,
 * so two plans sharing an id meant the earlier branch silently won and a Scale
 * customer could be provisioned as Founding (or vice versa) with nothing logged.
 * A copy-paste in the deploy env is exactly how that happens, and the only
 * symptom would be wrong entitlements months later. Checked lazily (first
 * checkout or first webhook) rather than at boot so config-less dev/test runs
 * and the unit tests stay silent.
 */
let productConfigChecked = false;
function checkProductConfig(): void {
  if (productConfigChecked) return;
  productConfigChecked = true;

  const configured: Array<[Plan, string]> = [];
  for (const plan of ["founding", "scale", "paid"] as const) {
    const id = productIdFor(plan)?.trim();
    if (id) configured.push([plan, id]);
  }
  const byId = new Map<string, Plan>();
  for (const [plan, id] of configured) {
    const owner = byId.get(id);
    if (owner) {
      const msg =
        `Dodo product misconfiguration: DODO_PRODUCT_${owner.toUpperCase()} and ` +
        `DODO_PRODUCT_${plan.toUpperCase()} are the same id (${id}). Subscriptions will be ` +
        `provisioned as "${owner}" regardless of what the customer bought. Fix the env and redeploy.`;
      console.error(msg);
      void alertAdmin("dodo-product-collision", msg);
    } else {
      byId.set(id, plan);
    }
  }
  if (configured.length === 0) {
    console.warn("no DODO_PRODUCT_* ids configured — checkout is unavailable for every plan");
  }
}

export function planForProduct(productId: string): Plan | undefined {
  checkProductConfig();
  // Precedence on a duplicate id is founding → scale → paid, same as before, but
  // checkProductConfig() has already screamed about the duplicate by this point
  // instead of letting it mis-map in silence.
  if (productId === config.DODO_PRODUCT_FOUNDING) return "founding";
  if (productId === config.DODO_PRODUCT_SCALE) return "scale";
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
 *
 * An unbuyable plan DEGRADES to Growth rather than throwing. DODO_PRODUCT_FOUNDING
 * has never been set, so anyone who arrived from a founding link (intended_plan =
 * 'founding') hit a checkout that threw every single time — a permanent dead end
 * with no way for the user to route around it. Same for a full cohort. The Dodo
 * checkout page shows the product and its price before any card is entered, so
 * the substitution is visible to the user before they commit to anything.
 *
 * `opts.returnUrl` is where Dodo drops the customer after payment. It defaults
 * to config.CHECKOUT_RETURN_URL, which production points at the Telegram bot —
 * correct for a Telegram buyer, badly wrong for a web buyer, who used to finish
 * paying inside the app and land on t.me. Web callers pass their own settings
 * URL; Telegram callers keep the default.
 */
export async function createCheckout(
  userId: string,
  email: string | null,
  plan: "paid" | "scale" | "founding",
  opts: { trialDays?: number; returnUrl?: string } = {},
): Promise<{ url: string }> {
  if (!config.DODO_API_KEY) throw new Error("DODO_API_KEY not configured");
  checkProductConfig();

  let resolvedPlan = plan;
  if (!productIdFor(resolvedPlan)) {
    console.warn(`Dodo product for plan "${resolvedPlan}" is not configured — falling back to Growth ("paid")`);
    if (resolvedPlan === "founding") {
      // Operator-visible: we are still linking people at a plan we cannot bill.
      void alertAdmin(
        "dodo-founding-unconfigured",
        "DODO_PRODUCT_FOUNDING is unset but users are reaching founding checkout. They are being " +
          "sent to the Growth product instead. Set the env var or stop linking ?plan=founding.",
      );
    }
    resolvedPlan = "paid";
  }

  if (resolvedPlan === "founding" && (await foundingSeatsLeft()) <= 0) {
    console.warn(`Founding cohort is full (${FOUNDING_CAP}/${FOUNDING_CAP}) — falling back to Growth ("paid")`);
    resolvedPlan = "paid";
  }

  const productId = productIdFor(resolvedPlan);
  // Only reachable when DODO_PRODUCT_PAID itself is missing, i.e. billing isn't
  // set up at all. There is nothing left to degrade to, so this one still throws.
  if (!productId) throw new Error(`Dodo product id for plan "${resolvedPlan}" not configured`);

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
      return_url: opts.returnUrl || config.CHECKOUT_RETURN_URL,
      // resolvedPlan, not the requested plan — the metadata has to describe what
      // they are actually being charged for or the webhook provisions the wrong tier.
      metadata: { user_id: userId, plan: resolvedPlan },
      ...(trial ? { subscription_data: trial } : {}),
    }),
  });
  if (!res.ok) throw new Error(`dodo checkout failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { checkout_url: string };
  return { url: data.checkout_url };
}

/**
 * Create a Dodo customer-portal session so the user can self-serve manage their
 * subscription — change/upgrade the plan, update the card, or cancel. Returns
 * the hosted portal URL to redirect to. Needs the Dodo `customer_id` we stored
 * from the subscription webhook.
 *
 * `returnUrl` defaults to config.CHECKOUT_RETURN_URL (the Telegram bot in prod).
 * Web callers pass their own settings URL — see createCheckout for why.
 */
export async function createCustomerPortal(customerId: string, returnUrl?: string): Promise<{ url: string }> {
  if (!config.DODO_API_KEY) throw new Error("DODO_API_KEY not configured");
  const res = await fetch(
    `${apiBase()}/customers/${encodeURIComponent(customerId)}/customer-portal/session`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.DODO_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ return_url: returnUrl || config.CHECKOUT_RETURN_URL }),
    },
  );
  if (!res.ok) throw new Error(`dodo customer portal failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { link: string };
  return { url: data.link };
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

/** Extra context the webhook route has (headers) that isn't in the JSON body. */
export interface DodoEventContext {
  /** Standard Webhooks `webhook-id`. Stable across Dodo's retries → idempotency key. */
  webhookId?: string;
  /** Standard Webhooks `webhook-timestamp` (epoch seconds). Used to order events. */
  webhookTimestamp?: string;
}

const STATUS_BY_EVENT: Record<string, string> = {
  "subscription.active": "active",
  "subscription.renewed": "active",
  "subscription.plan_changed": "active",
  "subscription.on_hold": "on_hold",
  "subscription.failed": "failed",
  "subscription.cancelled": "cancelled",
  "subscription.expired": "expired",
  // Money-back events. These used to be ignored entirely (the map only had
  // `subscription.*`), so a refunded customer or one who won a chargeback kept
  // full paid access forever — we were literally paying to serve them. They get
  // their own statuses rather than reusing 'cancelled', because 'cancelled' now
  // means "access until current_period_end" and a refund must revoke instantly.
  //
  // Deliberately conservative: only the terminal, money-actually-moved events.
  // `dispute.opened`/`challenged` are still contestable and `dispute.won` means
  // we KEPT the money, so none of those touch access.
  "refund.succeeded": "refunded",
  "dispute.lost": "disputed",
  "dispute.accepted": "disputed",
};

/**
 * The revoking statuses. Refund and dispute payloads are keyed off the *payment*
 * and don't reliably carry a subscription id, so these are the only ones allowed
 * to fall back to correlating by Dodo customer id.
 */
const REVOKING_STATUSES = new Set(["refunded", "disputed"]);

/**
 * Apply a verified Dodo webhook event to the subscriptions table.
 *
 * Idempotent in two senses now: the `webhook-id` is persisted so a replayed or
 * retried delivery is a no-op, and the event timestamp is compared against the
 * last one applied so an out-of-order delivery can't move the row backwards.
 * The old handler had neither — a delayed `subscription.active` landing after a
 * `subscription.cancelled` quietly resurrected a dead subscription.
 *
 * The claim and the apply share one transaction: if the apply throws, the claim
 * rolls back with it and Dodo's retry still gets a chance. Transient DB failures
 * are still allowed to propagate (the route 500s, Dodo retries — that is what we
 * want). Only the *deterministic* failures below are made safe, because those
 * would retry forever with the customer charged and unprovisioned.
 */
export async function handleDodoEvent(event: DodoSubscriptionEvent, ctx: DodoEventContext = {}): Promise<void> {
  const status = STATUS_BY_EVENT[event.type];
  const d = event.data;

  if (!status) {
    // payment.* and the non-terminal dispute.* events are informational for now.
    // An unrecognised *product* on a recognised event is a different story — see below.
    return;
  }

  // Event ordering. Prefer the signed webhook timestamp (Standard Webhooks, in
  // seconds); fall back to "now" when a caller has none, which degrades to the
  // old last-writer-wins behaviour rather than dropping the event.
  const tsSeconds = Number(ctx.webhookTimestamp);
  const eventAt = new Date(Number.isFinite(tsSeconds) && tsSeconds > 0 ? tsSeconds * 1000 : Date.now());

  const userId = d.metadata?.["user_id"];
  const plan = d.product_id ? planForProduct(d.product_id) : undefined;

  if (d.product_id && !plan) {
    // A live subscription for a product we don't recognise: someone added a
    // product in the Dodo dashboard without wiring the env var, or the env
    // points at the wrong environment's ids. The row below still gets written
    // (defaulted to the entry tier) so the customer isn't left unprovisioned,
    // but this needs a human.
    const msg =
      `Dodo webhook "${event.type}" carried an unrecognised product id (${d.product_id}). ` +
      `It matches none of DODO_PRODUCT_PAID/SCALE/FOUNDING, so the plan was defaulted to Growth. ` +
      `Check the product ids for ${config.DODO_ENV}.`;
    console.error(msg);
    void alertAdmin("dodo-unknown-product", msg);
  }

  await withTransaction(async (client) => {
    // Idempotency claim. ON CONFLICT DO NOTHING → zero rows means we've already
    // applied this exact delivery, so stop.
    if (ctx.webhookId) {
      const claim = await client.query(
        `INSERT INTO billing_webhook_events (webhook_id, event_type) VALUES ($1, $2)
         ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`,
        [ctx.webhookId, event.type],
      );
      if (claim.rowCount === 0) {
        console.log(`dodo webhook ${ctx.webhookId} already applied — ignoring replay`);
        return;
      }
    }

    if (userId) {
      // A dodo_subscription_id already owned by ANOTHER user violates the UNIQUE
      // index on that column, which used to surface as a 23505 → 500 → Dodo
      // retrying the same event forever. Release the id from the stale owner
      // first so the upsert below can take it. Reachable when a user checks out
      // twice under different accounts, or when checkout metadata points at a
      // different user id than the one that previously held the subscription.
      if (d.subscription_id) {
        const stolen = await client.query(
          `UPDATE subscriptions SET dodo_subscription_id = NULL, updated_at = now()
           WHERE dodo_subscription_id = $1 AND user_id <> $2`,
          [d.subscription_id, userId],
        );
        if (stolen.rowCount) {
          const msg =
            `Dodo subscription ${d.subscription_id} moved from another user to ${userId}. ` +
            `The previous owner's row has been detached — check for a duplicate account or a bad checkout metadata.`;
          console.error(msg);
          void alertAdmin("dodo-subscription-reassigned", msg);
        }
      }

      // `plan` is NOT NULL. The insert branch used to pass `plan ?? null` and
      // blow up on an unrecognised/absent product id — a guaranteed 500 loop.
      // Default to the entry paid tier instead: the customer HAS paid, so
      // provisioning them at the cheapest paid tier fails safer than leaving
      // them on 'free', and the alert above tells us to correct it. The UPDATE
      // branch still keeps the existing plan, so this can never downgrade a
      // known Scale customer.
      const insertPlan = plan ?? "paid";

      // The ON CONFLICT WHERE is the ordering guard: an event older than the one
      // we last applied updates nothing. Webhook delivery is not ordered, and
      // without this a delayed `subscription.active` arriving after
      // `subscription.cancelled` handed a cancelled user their entitlements back.
      const res = await client.query(
        `INSERT INTO subscriptions (user_id, provider, dodo_customer_id, dodo_subscription_id, plan, status, current_period_end, last_event_at, updated_at)
         VALUES ($1, 'dodo', $2, $3, $7, $5, $6, $8, now())
         ON CONFLICT (user_id) DO UPDATE SET
           dodo_customer_id = COALESCE(EXCLUDED.dodo_customer_id, subscriptions.dodo_customer_id),
           dodo_subscription_id = COALESCE(EXCLUDED.dodo_subscription_id, subscriptions.dodo_subscription_id),
           plan = COALESCE($4, subscriptions.plan),
           status = EXCLUDED.status,
           current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           last_event_at = EXCLUDED.last_event_at,
           updated_at = now()
         WHERE subscriptions.last_event_at IS NULL OR subscriptions.last_event_at <= EXCLUDED.last_event_at`,
        [
          userId,
          d.customer?.customer_id ?? null,
          d.subscription_id ?? null,
          plan ?? null,
          status,
          d.next_billing_date ?? null,
          insertPlan,
          eventAt,
        ],
      );
      if (res.rowCount === 0) {
        console.warn(`dodo event "${event.type}" for user ${userId} is older than the last applied event — ignored`);
      }
      return;
    }

    // Fallback: correlate by subscription id when metadata is missing (e.g. renewals).
    if (d.subscription_id) {
      await client.query(
        `UPDATE subscriptions
            SET status = $2,
                current_period_end = COALESCE($3, current_period_end),
                last_event_at = $4,
                updated_at = now()
          WHERE dodo_subscription_id = $1
            AND (last_event_at IS NULL OR last_event_at <= $4)`,
        [d.subscription_id, status, d.next_billing_date ?? null, eventAt],
      );
      return;
    }

    // Refund/dispute payloads don't always carry a subscription id — they are
    // keyed off the payment. Correlate by Dodo customer as a last resort, and
    // only for the revoking statuses, where being slightly over-eager is the
    // safe direction (we stop serving someone who got their money back).
    if (REVOKING_STATUSES.has(status) && d.customer?.customer_id) {
      await client.query(
        `UPDATE subscriptions
            SET status = $2, last_event_at = $3, updated_at = now()
          WHERE dodo_customer_id = $1 AND (last_event_at IS NULL OR last_event_at <= $3)`,
        [d.customer.customer_id, status, eventAt],
      );
      return;
    }

    console.warn(`dodo event "${event.type}" had no user_id, subscription_id or customer_id to correlate on`);
  });

  // Monetization event — only the transition INTO an active subscription, not
  // the informational churn/renewal statuses. Fired after the transaction so a
  // rolled-back apply never reports a phantom conversion.
  if (status === "active" && userId) {
    track(userId, "subscription_activated", { plan: plan ?? "unknown", provider: "dodo" });
  }
}
