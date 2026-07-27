-- Billing hardening: webhook idempotency, event ordering, and revocation states.
-- Additive/forward-only.
--
-- 1. Webhook replay. The Dodo route verified the Standard Webhooks signature but
--    threw the `webhook-id` away, so a replayed (or Dodo-retried) delivery was
--    applied a second time. Standard Webhooks guarantees the id is stable across
--    retries of the SAME event, which makes it a natural idempotency key.
--    Rows are claimed inside the same transaction that applies the event, so a
--    failed apply rolls the claim back and Dodo's retry still gets through.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  webhook_id   text PRIMARY KEY,
  event_type   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- Housekeeping: the table only exists to dedupe retries (Dodo gives up long
-- before this), so old rows can be pruned by date.
CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_received ON billing_webhook_events (received_at DESC);

-- 2. Out-of-order events. Webhook delivery is not ordered: a delayed
--    `subscription.active` arriving after `subscription.cancelled` used to
--    silently re-activate a dead subscription (and hand back entitlements).
--    We now stamp the event time we last applied and refuse anything older.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

-- 3. Refunds and lost disputes. `STATUS_BY_EVENT` only understood
--    `subscription.*`, so a refunded or charged-back customer kept full access
--    forever. Those get their own statuses rather than reusing 'cancelled',
--    because 'cancelled' now means "paid through current_period_end, access
--    continues until then" while a refund/chargeback must revoke immediately.
--    The 0001 constraint is inline+unnamed, so Postgres auto-named it
--    subscriptions_status_check (same dance as 0025/0027).
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('none','active','on_hold','cancelled','failed','expired','trialing','refunded','disputed'));
