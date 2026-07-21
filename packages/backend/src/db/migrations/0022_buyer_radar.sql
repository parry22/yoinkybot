-- Buyer Radar (§3h). Finds people on X expressing a need/pain/buying signal that
-- maps to what the user sells, scores that intent DETERMINISTICALLY, gates it
-- semantically against the user's actual domain, then hands over a ready-to-approve
-- reply drafted in the user's voice — ideally anchored to one of their own prior
-- takes (the search_memory "receipts" moat). Never auto-sends. Additive only;
-- applies clean on a fresh DB and an existing one.

-- ── ICP (buyer profile) — who BUYS the thing, distinct from brand_profiles ──
-- brand_profiles describes the creator's brand + content audience; the ICP is
-- "who is in-market for my product". One row per user. profile_id (owner) is
-- split from user_id (access) per the agency-prep invariant (see 0001); equal
-- in v1. icp_embedding is the niche-gate vector — an embedding of the product +
-- buyer + pain phrasings, recomputed on every edit.
CREATE TABLE icp_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id        uuid NOT NULL,                       -- owner vs access (see 0001); == user_id in v1
  product_oneliner  text,                                -- what they sell, plain
  buyer_description text,                                -- who the buyer is (role, stage, context)
  pain_signals      text[] NOT NULL DEFAULT '{}',        -- phrasings a buyer uses when in-market
  competitor_terms  text[] NOT NULL DEFAULT '{}',        -- names/handles that drive "switching from X" queries
  exclusions        text[] NOT NULL DEFAULT '{}',        -- contexts that are NOT the buyer (kill false positives)
  icp_embedding     vector(1536),                        -- niche-gate vector, recomputed on edit
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX idx_icp_profiles_user ON icp_profiles (user_id);
CREATE INDEX idx_icp_profiles_embedding ON icp_profiles USING hnsw (icp_embedding vector_cosine_ops);

-- ── buyer_signals — one row per surfaced OR considered prospect tweet ──
-- Doubles as the dedup ledger (never resurface the same tweet; cool repeat
-- authors) and the tuning surface (`verdict`). `components` and `agent_steps`
-- are inspectable, never a black box (mirrors surfacings.payload + agent_steps).
-- A row with verdict 'rejected' is a model decline (fires:false) — recorded so
-- it's deduped, but it did NOT burn the send budget.
CREATE TABLE buyer_signals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id       uuid NOT NULL,                        -- owner vs access (see 0001); == user_id in v1
  tweet_id         text NOT NULL,
  author_id        text,
  author_handle    text NOT NULL,                        -- for the repeat-author cooldown
  author_name      text,
  author_followers integer,
  content          text NOT NULL,
  url              text,
  score            real NOT NULL,                        -- deterministic intentScore
  components       jsonb,                                -- the intentScore breakdown (inspectable)
  intent_type      text,                                 -- explicit_ask | competitor_dissatisfaction | pain | trigger_event
  niche_similarity real,                                 -- 1 - cosine distance to the ICP vector
  why              text,                                 -- Yoinky's own casual rationale (chatter)
  draft_reply      text,                                 -- the reply to the prospect (feed voice)
  receipt_ref      text,                                 -- memory id/date the draft anchored to, if any
  agent_steps      jsonb,                                -- the bounded composition loop's tool trail
  verdict          text NOT NULL DEFAULT 'surfaced'
                     CHECK (verdict IN ('surfaced','replied','skipped','not_a_fit','rejected')),
  verdict_reason   text,
  surfacing_id     uuid REFERENCES surfacings(id) ON DELETE SET NULL,  -- set only on proactive delivery
  posted_at        timestamptz,                          -- when the prospect tweet was posted
  surfaced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tweet_id)                             -- never the same tweet twice per user
);
CREATE INDEX idx_buyer_signals_user ON buyer_signals (user_id, surfaced_at DESC);
CREATE INDEX idx_buyer_signals_author ON buyer_signals (user_id, author_handle, surfaced_at DESC);
CREATE INDEX idx_buyer_signals_verdict ON buyer_signals (user_id, verdict);

-- New surfacing type for the (dark, phase-two) proactive DM path. Like
-- viral_benchmark it gets its OWN budget and is NOT added to PROACTIVE_TYPES
-- (surfacing/cadence.ts). v1 delivery is pull-only via the web app, so nothing
-- writes this yet — the type is here so the dark job can be enabled without a
-- second migration.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match',
   'progress_report','reply_draft','weekly_plan','performance_alert','reputation_alert',
   'nudge','trend_take','viral_benchmark','buyer_signal'));
