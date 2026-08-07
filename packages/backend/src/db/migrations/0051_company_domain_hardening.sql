-- Company Narrative Engine hardening: complete the additive tenancy model,
-- preserve expert-owned voices, and extend provenance through outcomes.

ALTER TABLE organization_members
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited','active','suspended','removed')),
  ADD COLUMN invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE organization_members SET created_at = joined_at WHERE created_at <> joined_at;

ALTER TABLE workspaces
  ADD COLUMN industry text,
  ADD COLUMN website text,
  ADD COLUMN primary_objective_key text CHECK (primary_objective_key IN (
    'category_awareness','founder_authority','inbound_pipeline','product_adoption',
    'developer_adoption','customer_education','sales_enablement','recruiting','fundraising'
  )),
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','archived','deleting'));

ALTER TABLE workspace_members
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE workspace_members SET created_at = joined_at WHERE created_at <> joined_at;

ALTER TABLE experts
  ADD COLUMN is_public_voice boolean NOT NULL DEFAULT false;

-- An expert owns a versioned voice independently of whether that expert has a
-- Yoinky login. Existing personal voice_profiles remain untouched and are used
-- as a compatibility fallback for linked users.
CREATE TABLE expert_voice_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expert_id uuid NOT NULL,
  version integer NOT NULL,
  traits jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_capture_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, expert_id)
    REFERENCES experts(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (expert_id, version)
);
CREATE INDEX expert_voice_profiles_workspace
  ON expert_voice_profiles(workspace_id, expert_id, version DESC);

ALTER TABLE content_assets
  ADD COLUMN expert_id uuid,
  ADD CONSTRAINT content_assets_expert_same_workspace
    FOREIGN KEY (workspace_id, expert_id) REFERENCES experts(workspace_id, id) ON DELETE SET NULL;

ALTER TABLE scheduled_posts ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX scheduled_posts_workspace ON scheduled_posts(workspace_id, scheduled_for DESC);

ALTER TABLE users ADD COLUMN telegram_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE TABLE workspace_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_audit_logs_workspace
  ON workspace_audit_logs(workspace_id, created_at DESC);

ALTER TABLE claim_registry
  ADD COLUMN evidence_object_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE conversion_actions ADD COLUMN tracking_token_encrypted text;

ALTER TABLE content_lineage DROP CONSTRAINT IF EXISTS content_lineage_source_type_check;
ALTER TABLE content_lineage DROP CONSTRAINT IF EXISTS content_lineage_target_type_check;
ALTER TABLE content_lineage ADD CONSTRAINT content_lineage_source_type_check
  CHECK (source_type IN ('capture','knowledge_object','claim','narrative','brief','asset','publication','performance'));
ALTER TABLE content_lineage ADD CONSTRAINT content_lineage_target_type_check
  CHECK (target_type IN ('knowledge_object','claim','narrative','brief','asset','publication','performance','conversion','opportunity'));

CREATE TABLE publication_performance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  content_asset_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('x','linkedin')),
  metrics jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,content_asset_id) REFERENCES content_assets(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX publication_performance_workspace ON publication_performance_snapshots(workspace_id,observed_at DESC);

-- Social refreshes already update immutable capture metadata with metrics. This
-- trigger links only genuine provider metrics back to a company publication;
-- it never invents unavailable fields or zeroes.
CREATE OR REPLACE FUNCTION link_company_publication_performance() RETURNS trigger AS $$
DECLARE publication record; snapshot_id uuid; engagement jsonb;
BEGIN
  engagement := NEW.metadata->'engagement';
  IF engagement IS NULL OR engagement = '{}'::jsonb THEN RETURN NEW; END IF;
  SELECT sp.id,sp.workspace_id,sp.content_asset_id,sp.platform INTO publication
    FROM scheduled_posts sp
   WHERE sp.user_id=NEW.user_id AND sp.workspace_id IS NOT NULL AND sp.status='published'
     AND (sp.external_url=NEW.metadata->>'url' OR (sp.external_id IS NOT NULL AND NEW.client_id LIKE '%'||sp.external_id||'%'))
   ORDER BY sp.published_at DESC LIMIT 1;
  IF publication.id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO publication_performance_snapshots(workspace_id,publication_id,content_asset_id,platform,metrics)
    VALUES(publication.workspace_id,publication.id,publication.content_asset_id,publication.platform,engagement)
    RETURNING id INTO snapshot_id;
  INSERT INTO content_lineage(workspace_id,source_type,source_id,target_type,target_id,relationship_type)
    VALUES(publication.workspace_id,'publication',publication.id,'performance',snapshot_id,'measured_as')
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captures_link_company_performance
AFTER INSERT OR UPDATE OF metadata ON captures
FOR EACH ROW EXECUTE FUNCTION link_company_publication_performance();
