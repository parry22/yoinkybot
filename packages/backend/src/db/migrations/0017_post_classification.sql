-- Post classification: rhetorical mode, sincerity register, motive, and
-- build-in-public campaign detection. Classified at CAPTURE granularity, not
-- per-memory — positions are already anchored per capture (jobs/extract.ts),
-- and "shitpost"/"build-in-public"/"confessional" describe the whole authored
-- post, not a split-out idea inside it. Additive, NULL-tolerant throughout
-- (same precedent as `orientation` in 0006_grounded_analysis.sql): old
-- captures with no classification behave exactly as before.

ALTER TABLE captures ADD COLUMN rhetorical_mode text;             -- validated in app code against ALL_TONE_KEYS (TS-owned, evolves)
ALTER TABLE captures ADD COLUMN format_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE captures ADD COLUMN sincerity_register text
  CHECK (sincerity_register IN ('sincere','ironic','self_deprecating','absurdist','ambiguous'));
ALTER TABLE captures ADD COLUMN motive text
  CHECK (motive IN ('authority_building','relationship_building','audience_growth',
                     'lead_generation','personal_processing','community_participation',
                     'campaign_installment'));
ALTER TABLE captures ADD COLUMN mode_confidence real;
ALTER TABLE captures ADD COLUMN sincerity_confidence real;
ALTER TABLE captures ADD COLUMN motive_confidence real;

-- A detected recurring series of posts (build-in-public style). One row per
-- series; representative_embedding lets new captures be compared against the
-- series without re-querying every member post.
CREATE TABLE campaigns (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                   text NOT NULL,
  structural_marker       text,
  representative_embedding vector(1536),
  first_capture_at        timestamptz NOT NULL,
  last_capture_at         timestamptz NOT NULL,
  post_count              integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaigns_user ON campaigns (user_id, last_capture_at DESC);

ALTER TABLE captures ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE captures ADD COLUMN campaign_installment_number integer;

-- Per-user correction log: a permanent training signal, independent of
-- whether the corrected capture is later forgotten.
CREATE TABLE classification_corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_id      uuid REFERENCES captures(id) ON DELETE SET NULL,
  field           text NOT NULL CHECK (field IN ('rhetorical_mode','sincerity_register','motive')),
  previous_value  text,
  corrected_value text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_classification_corrections_user ON classification_corrections (user_id, field, created_at DESC);

-- Durable "already told them" guard for the repeated-correction acknowledgment
-- — without this the check would re-fire every time the count stays above
-- threshold, not just once.
CREATE TABLE correction_acknowledgments (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field           text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, field)
);

-- Monthly per-user calibration note, re-derived from classification_corrections.
CREATE TABLE classification_calibration (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  note       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Peers get only mode + sincerity — no motive/campaign/confidence. Peers have
-- no positions, belief graph, or voice profile (benchmark/peers.ts doctrine);
-- motive and campaigns are strategic concepts that don't apply to them.
ALTER TABLE peer_captures ADD COLUMN rhetorical_mode text;
ALTER TABLE peer_captures ADD COLUMN sincerity_register text
  CHECK (sincerity_register IN ('sincere','ironic','self_deprecating','absurdist','ambiguous'));
