-- Yoink core schema. Captures are immutable; memories are derived and re-derivable.
-- Agency prep (PRD 4.10): memories/positions carry profile_id (owner) separate from
-- user_id (access). In v1 they are always equal.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id   bigint UNIQUE,
  email         text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb
  -- settings: { quiet_hours: {start,end,tz}, resurface_per_week, timezone }
);

CREATE TABLE captures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN
                 ('telegram_voice','telegram_text','x_import','linkedin_import','extension')),
  raw_text     text,
  audio_url    text,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','transcribing','extracting','processed','failed'))
);
CREATE INDEX idx_captures_user ON captures (user_id, captured_at DESC);

CREATE TABLE memories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id       uuid NOT NULL,
  capture_id       uuid REFERENCES captures(id) ON DELETE SET NULL,
  content          text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('idea','claim','question','story','reaction')),
  embedding        vector(1536),
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_surfaced_at timestamptz,
  surface_count    integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'))
);
CREATE INDEX idx_memories_user ON memories (user_id, status, created_at DESC);
CREATE INDEX idx_memories_tsv ON memories USING gin (tsv);
CREATE INDEX idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE memory_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_a   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_b   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type  text NOT NULL CHECK (link_type IN ('extends','contradicts','echoes','answers')),
  strength   real NOT NULL DEFAULT 0.5,
  created_by text NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto','user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_a, memory_b, link_type)
);
CREATE INDEX idx_links_a ON memory_links (memory_a);
CREATE INDEX idx_links_b ON memory_links (memory_b);

CREATE TABLE positions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id        uuid NOT NULL,
  statement         text NOT NULL,
  first_stated_at   timestamptz NOT NULL DEFAULT now(),
  last_affirmed_at  timestamptz NOT NULL DEFAULT now(),
  source_memory_ids uuid[] NOT NULL DEFAULT '{}',
  embedding         vector(1536),
  version           integer NOT NULL DEFAULT 1,
  superseded_by     uuid REFERENCES positions(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','evolved'))
);
CREATE INDEX idx_positions_user ON positions (user_id, status);
CREATE INDEX idx_positions_embedding ON positions
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE surfacings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_ids    uuid[] NOT NULL DEFAULT '{}',
  type          text NOT NULL CHECK (type IN ('resurface','consistency_flag','macro_match')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- composed text, reasoning, match source
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  channel       text NOT NULL DEFAULT 'telegram',
  user_reaction text CHECK (user_reaction IN ('fire','later','forget')),
  reaction_at   timestamptz
);
CREATE INDEX idx_surfacings_user ON surfacings (user_id, delivered_at DESC);

CREATE TABLE voice_profiles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version                 integer NOT NULL,
  traits                  jsonb NOT NULL,
  built_from_memory_count integer NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version)
);

CREATE TABLE usage_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,           -- extract | link | search | compose | consistency | voice | draft | macro | embed | stt
  tokens_in  integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  model      text NOT NULL,
  cost       numeric(12,6) NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_user ON usage_events (user_id, at DESC);

CREATE TABLE extension_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  label        text NOT NULL DEFAULT 'extension',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE telegram_link_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE clusters (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      text NOT NULL,
  memory_ids uuid[] NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_clusters_user ON clusters (user_id, built_at DESC);

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider             text NOT NULL DEFAULT 'dodo',
  dodo_customer_id     text,
  dodo_subscription_id text UNIQUE,
  plan                 text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','paid','founding')),
  status               text NOT NULL DEFAULT 'none'
                       CHECK (status IN ('none','active','on_hold','cancelled','failed','expired')),
  current_period_end   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Founding cohort cap (first 500) is enforced in code by counting plan='founding' rows.
