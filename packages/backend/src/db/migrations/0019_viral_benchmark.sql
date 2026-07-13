-- Daily viral tweet case study (§3h). A single-tweet spotlight: once a day,
-- one high-impression, niche-relevant tweet + a computed "why it worked"
-- breakdown + a suggested angle. Distinct from the macro-moment agent
-- (aggregate discourse) and from peer benchmarking (relative to known peers).
-- Additive only.

-- New surfacing type for the delivery. Own visual framing; NOT added to
-- PROACTIVE_TYPES (surfacing/cadence.ts) — it has its own once-a-day budget.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match',
   'progress_report','reply_draft','weekly_plan','performance_alert','reputation_alert',
   'nudge','trend_take','viral_benchmark'));

-- The dedup ledger + delivery record. One row per sent case study, so the same
-- tweet is never resent and a repeat-offender author is held off for a cooldown
-- window. Also the tuning surface: `reaction` records the user's 👍/👎.
CREATE TABLE viral_benchmarks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tweet_id      text NOT NULL,            -- the spotlighted tweet's id
  author_handle text NOT NULL,            -- for the repeat-author cooldown
  view_count    integer NOT NULL,
  url           text,
  surfacing_id  uuid REFERENCES surfacings(id) ON DELETE SET NULL,
  reaction      text CHECK (reaction IN ('useful','off')),  -- 👍 / 👎, null until tapped
  reaction_at   timestamptz,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tweet_id)             -- never the same tweet twice per user
);
CREATE INDEX idx_viral_benchmarks_user ON viral_benchmarks (user_id, sent_at DESC);
CREATE INDEX idx_viral_benchmarks_author ON viral_benchmarks (user_id, author_handle, sent_at DESC);
