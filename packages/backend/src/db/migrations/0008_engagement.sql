-- Engagement / community management: public replies + quote-posts on the
-- user's work, scored in code, one draft reply surfaced at a time.
-- Scope: PUBLIC mentions only — DMs are deliberately out (different trust
-- surface: impersonation + privacy risk; needs its own design).

CREATE TABLE mentions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform                 text NOT NULL CHECK (platform IN ('x','linkedin')),
  external_id              text NOT NULL,          -- provider tweet/post id (dedup)
  url                      text,
  author_handle            text NOT NULL,
  author_reach             integer NOT NULL DEFAULT 0,   -- follower count at fetch time
  content                  text NOT NULL,
  posted_at                timestamptz NOT NULL,
  fetched_at               timestamptz NOT NULL DEFAULT now(),
  sentiment                text CHECK (sentiment IN ('positive','neutral','negative')),
  is_question              boolean NOT NULL DEFAULT false,
  is_substantive_challenge boolean NOT NULL DEFAULT false,
  relationship_strength    real NOT NULL DEFAULT 0,      -- derived from interaction history (no connections table yet)
  reply_worthy_score       real NOT NULL DEFAULT 0,
  reply_status             text NOT NULL DEFAULT 'none'
                           CHECK (reply_status IN ('none','drafted','sent','skipped')),
  draft_text               text,                          -- the suggested reply, once drafted
  reply_drafted_at         timestamptz,
  reply_sent_at            timestamptz,
  UNIQUE (user_id, platform, external_id)
);
CREATE INDEX idx_mentions_queue ON mentions (user_id, reply_status, reply_worthy_score DESC);

CREATE TABLE sent_replies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mention_id         uuid NOT NULL REFERENCES mentions(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_text         text NOT NULL,
  -- Consistently-heavy editing is a measurable voice/judgment tuning signal.
  edited_before_send boolean NOT NULL DEFAULT false,
  sent_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sent_replies_user ON sent_replies (user_id, sent_at DESC);

-- Reply drafts are a proactive surfacing type sharing the same weekly budget.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match','progress_report','reply_draft'));
