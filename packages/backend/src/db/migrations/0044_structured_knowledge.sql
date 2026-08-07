-- Company Narrative Engine, Phase B: traceable, permission-aware knowledge.

CREATE TABLE workspace_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type        text NOT NULL CHECK (source_type IN (
                       'manual_text','voice_note','uploaded_transcript','founder_interview',
                       'x_history','linkedin_history','product_update','customer_call',
                       'sales_call','support_item','internal_document','market_research')),
  name               text NOT NULL,
  owner_expert_id    uuid REFERENCES experts(id) ON DELETE SET NULL,
  integration_id     text,
  capture_frequency  text,
  permission_level   text NOT NULL DEFAULT 'internal' CHECK (permission_level IN (
                       'public','internal','restricted','confidential','never_use_for_generation')),
  extraction_policy  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','failed')),
  last_ingested_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_sources_workspace ON workspace_sources (workspace_id, created_at DESC);

ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_source_check;
ALTER TABLE captures ADD CONSTRAINT captures_source_check CHECK (source IN (
  'telegram_voice','telegram_text','x_import','linkedin_import','extension','extension_moment',
  'manual_text','voice_note','uploaded_transcript','founder_interview','product_update',
  'customer_call','sales_call','support_item','internal_document','market_research'));
ALTER TABLE captures ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE captures ADD COLUMN source_id uuid REFERENCES workspace_sources(id) ON DELETE SET NULL;
ALTER TABLE captures ADD COLUMN speaker_expert_id uuid REFERENCES experts(id) ON DELETE SET NULL;
ALTER TABLE captures ADD COLUMN permission_level text NOT NULL DEFAULT 'internal'
  CHECK (permission_level IN ('public','internal','restricted','confidential','never_use_for_generation'));
CREATE INDEX captures_workspace ON captures (workspace_id, captured_at DESC);

CREATE TABLE knowledge_objects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_type           text NOT NULL CHECK (object_type IN (
                          'insight','claim','proof','story','objection','question','framework',
                          'capability','customer_quote','language_phrase','market_signal')),
  title                 text NOT NULL,
  body                  text NOT NULL,
  content_hash          text NOT NULL,
  source_capture_id     uuid NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  speaker_expert_id     uuid REFERENCES experts(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','reviewed','approved','rejected','archived')),
  confidence            real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  permission_level      text NOT NULL CHECK (permission_level IN (
                          'public','internal','restricted','confidential','never_use_for_generation')),
  audience_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
  problem_ids           jsonb NOT NULL DEFAULT '[]'::jsonb,
  buying_stage          text,
  product_area          text,
  commercial_relevance text,
  expiry_at             timestamptz,
  embedding             vector(1536),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, content_hash, object_type),
  UNIQUE (workspace_id, id)
);
CREATE INDEX knowledge_objects_workspace_review
  ON knowledge_objects (workspace_id, status, created_at DESC);
CREATE INDEX knowledge_objects_source ON knowledge_objects (source_capture_id);
CREATE INDEX knowledge_objects_embedding ON knowledge_objects
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE knowledge_relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_object_id    uuid NOT NULL,
  to_object_id      uuid NOT NULL,
  relationship_type text NOT NULL CHECK (relationship_type IN (
                      'supports','contradicts','extends','illustrates','answers',
                      'evidences','derived_from','related_to','used_in')),
  confidence        real NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  created_by        text NOT NULL DEFAULT 'model' CHECK (created_by IN ('model','user','system')),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (from_object_id <> to_object_id),
  FOREIGN KEY (workspace_id, from_object_id)
    REFERENCES knowledge_objects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, to_object_id)
    REFERENCES knowledge_objects(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, from_object_id, to_object_id, relationship_type)
);
CREATE INDEX knowledge_relationships_workspace ON knowledge_relationships (workspace_id, created_at DESC);
