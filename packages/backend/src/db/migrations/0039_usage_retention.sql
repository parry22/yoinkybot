-- Retention for the operational/telemetry tables.
--
-- WHY NOW. Storage stopped being free. `usage_events` gains one row per LLM call
-- and per embedding batch and has never had a retention policy, and the daily
-- cap query (llm/gateway.ts underDailyCap) scans it on the hot path of EVERY
-- model call — so it is simultaneously the fastest-growing table and one of the
-- most frequently read. On a 500 MB ceiling that combination is the first thing
-- that bites.
--
-- ROLL UP, DON'T DELETE. Per-user spend history is the instrument for pricing
-- decisions (what a heavy user actually costs is the whole question behind the
-- lifetime plan), so blowing it away to save bytes would be trading something
-- irreplaceable for something cheap. Old rows are aggregated into `usage_daily`
-- first — one row per user/day/event_type/model instead of one per call, which is
-- a 100-1000x reduction while keeping every number that matters.
--
-- SCOPE: telemetry and operational tables ONLY. Deliberately NOT touching
-- captures, memories, surfacings, mentions, buyer_signals, drafts or angles —
-- those are the user's content and the product's own dedup//history depends on
-- them. Pruning those is a product decision, not housekeeping.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  day        date NOT NULL,
  event_type text NOT NULL,
  model      text NOT NULL,
  calls      integer NOT NULL DEFAULT 0,
  tokens_in  bigint  NOT NULL DEFAULT 0,
  tokens_out bigint  NOT NULL DEFAULT 0,
  cost       numeric(14, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, event_type, model)
);

-- `user_id` is nullable (usage_events lets it be — system jobs run with a null
-- userId), and NULL never equals NULL in a PRIMARY KEY comparison, so the PK
-- above cannot dedupe the fleet-job rows. This partial unique index does.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_daily_system
  ON usage_daily (day, event_type, model)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day DESC);

-- Makes the retention sweep's own delete cheap, and it is the access pattern the
-- rollup uses (everything older than a cutoff, ordered by time). The existing
-- idx_usage_user is (user_id, at DESC), which can't serve a user-agnostic scan by
-- date.
--
-- rate_limits and billing_webhook_events already ship their own window_start /
-- received_at indexes (0036, 0035), so the sweep's deletes on those are covered.
CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events (at);
