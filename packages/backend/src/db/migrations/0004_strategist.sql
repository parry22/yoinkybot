-- Personal Brand Strategist: connected accounts, the one-time diagnosis, elicited
-- goals, the confirmed plan, and the unlock-list items the proactive engine works.
-- Additive only.

-- Connected X/LinkedIn accounts (ingested via Apify by handle) -----------------
CREATE TABLE connected_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform         text NOT NULL CHECK (platform IN ('x','linkedin')),
  handle           text NOT NULL,             -- @handle or profile slug
  profile_url      text,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','ingesting','ingested','failed')),
  post_count       integer NOT NULL DEFAULT 0,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- bio, followers, cadence stats
  last_ingested_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform)
);

-- The foundational diagnosis (one active per user; versioned) ------------------
CREATE TABLE brand_diagnoses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version           integer NOT NULL DEFAULT 1,
  dimensions        jsonb NOT NULL,           -- the 5-dimension structured read
  built_from_count  integer NOT NULL,         -- memories analyzed
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version)
);

-- Goals: a special class of position, checked against every recommendation -----
CREATE TABLE goals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_type             text NOT NULL,        -- authority | audience | company | opportunity | other
  detail                text NOT NULL,        -- the specific articulation
  timeframe             text,
  definition_of_success text,
  embedding             vector(1536),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_goals_user ON goals (user_id, status);
CREATE INDEX idx_goals_embedding ON goals USING hnsw (embedding vector_cosine_ops);

-- The plan (one active per user; draft until the user confirms) ----------------
CREATE TABLE brand_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  diagnosis_id  uuid REFERENCES brand_diagnoses(id) ON DELETE SET NULL,
  throughline   text NOT NULL,                -- the one-sentence position to own
  cadence       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {perWeek, platforms, note}
  outside_in    text NOT NULL DEFAULT '',     -- the standing macro-moment instruction
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_plans_user ON brand_plans (user_id, status);

-- Unlock-list items: the unsaid ideas the proactive engine prioritizes ---------
CREATE TABLE unlock_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES brand_plans(id) ON DELETE CASCADE,
  idea        text NOT NULL,
  rationale   text NOT NULL DEFAULT '',
  priority    integer NOT NULL DEFAULT 0,     -- 1 = develop first (sequenced by goal impact)
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','developed','deprioritized')),
  embedding   vector(1536),
  memory_id   uuid REFERENCES memories(id) ON DELETE SET NULL,  -- content it became, if any
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_unlock_user ON unlock_items (user_id, status, priority);
CREATE INDEX idx_unlock_embedding ON unlock_items USING hnsw (embedding vector_cosine_ops);

-- Onboarding progress: where each user is in the 5-stage strategist flow -------
ALTER TABLE users ADD COLUMN strategist_stage text NOT NULL DEFAULT 'new'
  CHECK (strategist_stage IN ('new','connected','diagnosed','goals_set','plan_active'));
-- Transient elicitation state (which goal question we're awaiting, etc.).
ALTER TABLE users ADD COLUMN strategist_state jsonb NOT NULL DEFAULT '{}'::jsonb;
