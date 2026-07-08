-- Narrative-engine pivot: ambient "moments worth sharing", narrative angles, and trends.
-- Additive only. Captures stay immutable; memories stay the clean "your thinking" corpus.
-- Moments are a separate, discard-heavy corpus of worth-narrating events.

-- 1. New capture source + status for ambient moments -------------------------
ALTER TABLE captures DROP CONSTRAINT captures_source_check;
ALTER TABLE captures ADD CONSTRAINT captures_source_check CHECK (source IN
  ('telegram_voice','telegram_text','x_import','linkedin_import','extension','extension_moment'));

ALTER TABLE captures DROP CONSTRAINT captures_status_check;
ALTER TABLE captures ADD CONSTRAINT captures_status_check CHECK (status IN
  ('pending','transcribing','extracting','gating','processed','failed'));

-- 2. Idempotency for batched ambient capture ---------------------------------
ALTER TABLE captures ADD COLUMN client_id text;
CREATE UNIQUE INDEX idx_captures_client ON captures (user_id, client_id) WHERE client_id IS NOT NULL;

-- 3. Moments: worth-narrating events with browsing metadata ------------------
CREATE TABLE moments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id     uuid NOT NULL,               -- agency prep: owner vs access (see 0001)
  capture_id     uuid REFERENCES captures(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('read','selection','copy','compose','trend')),
  url            text,
  title          text,
  site           text,
  excerpt        text NOT NULL,
  embedding      vector(1536),
  signals        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- dwellMs, scrollDepth, wordCount, provider
  shareability   real NOT NULL DEFAULT 0,             -- deterministic score 0..1
  verdict        text NOT NULL DEFAULT 'pending'
                 CHECK (verdict IN ('pending','shareable','rejected','angled')),
  verdict_reason text,
  trend_id       uuid,                                -- set when kind='trend' (FK added below)
  created_at     timestamptz NOT NULL DEFAULT now(),
  gated_at       timestamptz
);
CREATE INDEX idx_moments_user ON moments (user_id, verdict, created_at DESC);
CREATE INDEX idx_moments_embedding ON moments USING hnsw (embedding vector_cosine_ops);

-- 4. Trends: shared across users, matched per-user by embedding --------------
CREATE TABLE trends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    text NOT NULL CHECK (platform IN ('x','linkedin','web','news')),
  source      text NOT NULL,                  -- provider name (apify | brave | tavily | x_api)
  external_id text NOT NULL,                  -- provider-scoped id for dedup
  topic       text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  url         text,
  volume      real,                           -- normalized popularity signal
  embedding   vector(1536),
  observed_at timestamptz NOT NULL DEFAULT now(),
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX idx_trends_embedding ON trends USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_trends_fetched ON trends (fetched_at DESC);

ALTER TABLE moments ADD CONSTRAINT moments_trend_fk
  FOREIGN KEY (trend_id) REFERENCES trends(id) ON DELETE SET NULL;

-- 5. Drafts: persist "write it for me" output for web + history --------------
CREATE TABLE drafts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  platform   text NOT NULL CHECK (platform IN ('x','linkedin')),
  source_memory_ids uuid[] NOT NULL DEFAULT '{}',
  angle_id   uuid,                            -- FK added after angles table
  note       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_drafts_user ON drafts (user_id, created_at DESC);

-- 6. Angles: the 3 framings offered per moment/trend -------------------------
CREATE TABLE angles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surfacing_id  uuid NOT NULL REFERENCES surfacings(id) ON DELETE CASCADE,
  moment_id     uuid REFERENCES moments(id) ON DELETE SET NULL,
  trend_id      uuid REFERENCES trends(id) ON DELETE SET NULL,
  slot          integer NOT NULL,             -- 1..3, the position shown to the user
  label         text NOT NULL,
  angle         text NOT NULL,
  hook          text NOT NULL,
  why_it_lands  text NOT NULL DEFAULT '',
  chosen        boolean NOT NULL DEFAULT false,
  draft_id      uuid REFERENCES drafts(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_angles_surfacing ON angles (surfacing_id, slot);

ALTER TABLE drafts ADD CONSTRAINT drafts_angle_fk
  FOREIGN KEY (angle_id) REFERENCES angles(id) ON DELETE SET NULL;

-- 7. Surfacings: unified delivery record gains angle/trend variants ----------
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match'));
ALTER TABLE surfacings ADD COLUMN moment_id uuid REFERENCES moments(id) ON DELETE SET NULL;
ALTER TABLE surfacings ADD COLUMN trend_id  uuid REFERENCES trends(id) ON DELETE SET NULL;
