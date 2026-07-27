-- Twice-daily automatic X refresh (jobs/x-refresh.ts).
--
-- Until now the only thing that pulled a user's X data was (a) the destructive
-- full re-ingest behind "Reconnect X", and (b) the daily performance pulse —
-- which is gated on `telegram_id IS NOT NULL` AND an active brand plan, so
-- web-only users never got a refresh at all. Their analytics, follower count and
-- voice signal were frozen at whatever they were on the day they connected, and
-- the only remedy the UI offered was to reconnect, which wipes and rebuilds the
-- whole corpus just to update some numbers.
--
-- `last_refreshed_at` is the staleness gate for the new sweep: distinct from
-- `last_ingested_at`, which means "the corpus was rebuilt from scratch" and must
-- keep that meaning (the diagnosis pipeline reads it).
--
-- Additive only.

ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz,
  -- Set on EVERY attempt, success or failure. `last_refreshed_at` alone would be
  -- a head-of-line trap: a permanently-broken handle (renamed, suspended, went
  -- private) never succeeds, so it would keep a NULL forever, sort first on every
  -- sweep, and burn a paid request twice a day for eternity. Once enough of those
  -- accumulate they'd consume the whole time budget and healthy accounts would
  -- stop being refreshed at all. The sweep's staleness gate reads THIS column;
  -- last_refreshed_at stays a truthful "when did we last actually get data".
  ADD COLUMN IF NOT EXISTS last_refresh_attempt_at timestamptz;

-- The sweep orders by "least recently attempted first", so it degrades sensibly
-- if the fleet ever outgrows one run's time budget.
CREATE INDEX IF NOT EXISTS idx_connected_accounts_refresh
  ON connected_accounts (platform, status, last_refresh_attempt_at);
