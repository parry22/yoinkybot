-- "Scale" plan tier. The landing page already offers growth/scale/founding, but
-- until now scale silently mapped to the 'paid' product. Make it a first-class
-- billable tier: its own Dodo product (DODO_PRODUCT_SCALE) and its own plan label,
-- so Settings can offer an explicit "move to Scale" and telemetry can tell the two
-- apart. Entitlements are the full paid set for now. Additive/forward-only.

-- Widen the plan CHECK to allow 'scale'. The 0001 constraint is inline+unnamed,
-- so Postgres auto-named it subscriptions_plan_check.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free','paid','scale','founding'));
