-- Two independent fixes that both needed a schema slot. Additive only; safe on
-- a fresh database and on one that already has 0024/0030 applied.

-- ── 1. Inspiration refresh: gate on ATTEMPT, not on success ──────────────────
--
-- web/inspiration.ts guarded its on-demand refresh with
-- `max(delivered_at) FROM surfacings WHERE type IN ('trend_take','viral_benchmark')`.
-- That timestamp only exists when the pipeline actually DELIVERED something. A
-- user whose niche has no matching trends and no viral pool writes no surfacing
-- row at all, so the guard read NULL on every page load and re-ran the billed
-- twitterapi.io search every single time the Inspiration tab was opened. The
-- barren niche — the one that earns nothing — was the one that cost the most.
--
-- Same reasoning as connected_accounts.last_refresh_attempt_at (0030): stamp the
-- attempt, whatever the outcome, and read the attempt when deciding staleness.
-- `delivered_at` keeps meaning "we actually surfaced something", which is what
-- the Inspiration lists themselves read.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS inspiration_refresh_attempt_at timestamptz;

-- ── 2. Automation approvals expire ───────────────────────────────────────────
--
-- automations/store.ts counts 'awaiting_approval' as a delivered post against
-- entitlements.automationPostsPerMonth (Growth = 5). Nothing ever aged those
-- rows out: no reaper, no TTL. Five ignored approval DMs and a Growth user's
-- Auto Agent was silently dead for the rest of the calendar month, with the cap
-- consumed by drafts nobody ever saw again.
--
-- 'expired' is a terminal status OUTSIDE the delivered set, so reaping a stale
-- approval hands the quota back. It is deliberately distinct from 'rejected'
-- (the user said no — real signal for tuning) and from 'skipped' (the pipeline
-- declined to produce anything).
ALTER TABLE automation_runs DROP CONSTRAINT IF EXISTS automation_runs_status_check;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_status_check CHECK (status IN (
  'drafting','awaiting_approval','approved','scheduled','posted',
  'rejected','edited','failed','skipped','expired'));

-- The reaper scans "awaiting_approval older than N", fleet-wide, on every tick.
CREATE INDEX IF NOT EXISTS idx_automation_runs_awaiting_age
  ON automation_runs (status, created_at) WHERE status = 'awaiting_approval';
