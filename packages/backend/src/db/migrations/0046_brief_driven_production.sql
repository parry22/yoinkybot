-- Company Narrative Engine, Phase D: grounded briefs, assets, reviews and lineage.

CREATE TABLE content_briefs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  objective              text NOT NULL,
  audience_id            uuid REFERENCES workspace_audiences(id) ON DELETE SET NULL,
  buying_stage           text NOT NULL DEFAULT 'problem_aware',
  territory_id           uuid REFERENCES editorial_territories(id) ON DELETE SET NULL,
  campaign_id            uuid,
  desired_belief_shift   text NOT NULL,
  core_insight_object_id uuid NOT NULL,
  primary_claim_id       uuid REFERENCES claim_registry(id) ON DELETE SET NULL,
  primary_proof_id       uuid,
  channel                text NOT NULL CHECK (channel IN ('x','linkedin')),
  format                 text NOT NULL,
  primary_emotion        text,
  cta_text               text,
  cta_id                 uuid,
  reason_now             text,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN (
                           'idea','draft','ready','in_production','completed','archived')),
  created_by_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, core_insight_object_id)
    REFERENCES knowledge_objects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, primary_proof_id)
    REFERENCES knowledge_objects(workspace_id, id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX content_briefs_workspace ON content_briefs (workspace_id, status, created_at DESC);

CREATE TABLE content_brief_sources (
  content_brief_id    uuid NOT NULL REFERENCES content_briefs(id) ON DELETE CASCADE,
  knowledge_object_id uuid NOT NULL REFERENCES knowledge_objects(id) ON DELETE RESTRICT,
  usage_role          text NOT NULL CHECK (usage_role IN (
                        'core_insight','claim','proof','example','customer_language',
                        'counterargument','story','context')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_brief_id, knowledge_object_id, usage_role)
);

CREATE TABLE content_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brief_id        uuid NOT NULL REFERENCES content_briefs(id) ON DELETE RESTRICT,
  asset_type      text NOT NULL CHECK (asset_type IN (
                    'x_post','linkedin_post','short_video_script','newsletter_section',
                    'blog_outline','sales_enablement','carousel_outline','community_prompt')),
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN (
                    'draft','needs_review','approved','scheduled','published','rejected','archived')),
  parent_asset_id uuid REFERENCES content_assets(id) ON DELETE SET NULL,
  created_by      text NOT NULL DEFAULT 'model' CHECK (created_by IN ('model','user','system')),
  check_results   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX content_assets_workspace ON content_assets (workspace_id, status, created_at DESC);

CREATE TABLE content_asset_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id             uuid NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  content              text NOT NULL,
  created_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_model     text,
  change_summary       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version)
);

CREATE TABLE content_lineage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type       text NOT NULL CHECK (source_type IN ('capture','knowledge_object','brief','asset','publication')),
  source_id         uuid NOT NULL,
  target_type       text NOT NULL CHECK (target_type IN ('knowledge_object','brief','asset','publication')),
  target_id         uuid NOT NULL,
  relationship_type text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_type, source_id, target_type, target_id, relationship_type)
);
CREATE INDEX content_lineage_source ON content_lineage (workspace_id, source_type, source_id);
CREATE INDEX content_lineage_target ON content_lineage (workspace_id, target_type, target_id);

CREATE TABLE asset_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id           uuid NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  reviewer_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision           text NOT NULL CHECK (decision IN ('approved','changes_requested','rejected','comment')),
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scheduled_posts ADD COLUMN content_asset_id uuid REFERENCES content_assets(id) ON DELETE SET NULL;

-- Existing Phase B records gain the first provenance edge when this table
-- becomes available. This is idempotent because the edge has a unique key.
INSERT INTO content_lineage (workspace_id, source_type, source_id, target_type, target_id, relationship_type)
SELECT workspace_id, 'capture', source_capture_id, 'knowledge_object', id, 'extracted_from'
  FROM knowledge_objects
ON CONFLICT DO NOTHING;
