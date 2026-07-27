-- Per-user burst rate limiting for expensive endpoints. Additive/forward-only.
--
-- WHY THIS EXISTS. Before this, the only backstops on paid work were the monthly
-- entitlement caps and the fleet-wide daily LLM budget. Neither bounds a BURST:
-- a signed-in paid user (or a stolen session) could fire many concurrent
-- /api/chat/stream, /api/draft or buyers-radar scans and spend a day's model +
-- twitterapi.io budget in minutes, with the monthly cap only catching up later.
--
-- Postgres rather than an in-process map because the web app runs on Vercel
-- functions: instances are ephemeral and concurrent, so an in-memory counter
-- bounds one lambda, not one user. Neon is already on the hot path of every one
-- of these routes, so this adds one cheap upsert to work that costs seconds.
--
-- Fixed-window counter, not a token bucket: one row per (user, bucket), the
-- window resets lazily inside the same UPSERT that increments it, so there is no
-- sweeper and no race — the whole check is a single atomic statement.
CREATE TABLE IF NOT EXISTS rate_limits (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket       text NOT NULL,             -- logical action, e.g. 'chat', 'buyer_scan'
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket)
);

-- Housekeeping only: lets an operator prune rows whose window aged out long ago.
-- Nothing reads this in the hot path (the PK covers that).
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
