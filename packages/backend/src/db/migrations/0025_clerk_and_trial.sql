-- Clerk identity + a real 7-day free trial.
--
-- Clerk becomes the web app's identity provider. A web user is now keyed by
-- their Clerk user id (in addition to email/telegram_id/x_user_id) — additive,
-- nullable, unique, exactly like the X identity in 0021.
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id text UNIQUE;

-- Trial: every new signup starts a 7-day full-access trial. We track it on the
-- subscriptions row so the existing entitlements/paywall path (entitlementsFor,
-- isPaidOrExempt) is the single place plans are resolved — no parallel system.
--   status 'trialing'  → on the free trial (paid-tier access) until trial_ends_at
--   trial_ends_at      → when the trial lapses; once past, entitlements fall to
--                        free and the upgrade wall (web + Telegram) kicks in
--   intended_plan      → the plan the user picked on the landing page at sign-up
--                        (growth/scale/founding), so the upgrade CTA is preselected
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS intended_plan text;

-- Widen the status CHECK to allow 'trialing'. The original constraint (0001) is
-- inline+unnamed, so Postgres auto-named it subscriptions_status_check.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('none','active','on_hold','cancelled','failed','expired','trialing'));
