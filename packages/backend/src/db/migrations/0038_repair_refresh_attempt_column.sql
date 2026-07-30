-- Repair: connected_accounts.last_refresh_attempt_at never got created.
--
-- WHAT HAPPENED. 0030_x_auto_refresh.sql originally added only
-- `last_refreshed_at`. It ran, and `schema_migrations` recorded the filename.
-- The column `last_refresh_attempt_at` was added to that *same file* afterwards,
-- so the runner (db/migrate.ts — `if (applied.has(file)) continue`, keyed on
-- filename, not content) never executed it again. The declaration and the
-- database silently disagreed from that moment on.
--
-- THE SYMPTOM. jobs/x-refresh.ts keys its staleness gate on this column
-- (three separate queries, plus the per-attempt UPDATE). Every one of them
-- raised `column ca.last_refresh_attempt_at does not exist`, so the twice-daily
-- X refresh failed on every single run — and because that queue is deliberately
-- `retryLimit: 0` (jobs/boss.ts NO_RETRY), it failed quietly and waited 12 hours
-- to fail again. Nobody's X data has actually been refreshing.
--
-- THE LESSON, for whoever edits a migration next: once a migration has run
-- anywhere, it is immutable. Add a new file instead.

ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS last_refresh_attempt_at timestamptz;

-- The sweep orders by least-recently-attempted first, so it degrades sensibly
-- if the fleet ever outgrows one run's time budget. 0030 declared this index
-- against the missing column, so it was never created either.
CREATE INDEX IF NOT EXISTS idx_connected_accounts_refresh
  ON connected_accounts (platform, status, last_refresh_attempt_at);

-- Backfill from the success timestamp so the first sweep after this migration
-- doesn't treat every existing account as never-attempted and try to refresh the
-- entire fleet in one tick (which the 45-minute budget would truncate anyway).
UPDATE connected_accounts
   SET last_refresh_attempt_at = last_refreshed_at
 WHERE last_refresh_attempt_at IS NULL
   AND last_refreshed_at IS NOT NULL;
