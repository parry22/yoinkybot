-- Workspace boundary hardening (release gate). No RLS — tenant isolation stays
-- in application authorization (requireWorkspaceRole) plus same-workspace FKs.
-- Postgres RLS is deferred until a multi-replica / multi-service access model
-- needs it; do not add policies here without an explicit product decision.

-- conversion_events already ships UNIQUE (workspace_id, deduplication_key) from
-- 0048. Re-assert for installs that may have dropped it, and document the
-- idempotent write contract used by recordConversionEvent / the public webhook.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversion_events_workspace_id_deduplication_key_key'
  ) THEN
    ALTER TABLE conversion_events
      ADD CONSTRAINT conversion_events_workspace_id_deduplication_key_key
      UNIQUE (workspace_id, deduplication_key);
  END IF;
END $$;

COMMENT ON CONSTRAINT conversion_events_workspace_id_deduplication_key_key
  ON conversion_events IS
  'Idempotent conversion ingest: ON CONFLICT (workspace_id, deduplication_key) / app-level duplicate check. Workspace-scoped only — never global.';

COMMENT ON TABLE conversion_events IS
  'Observed/influenced conversion events. Deduped per workspace via UNIQUE (workspace_id, deduplication_key). Cross-workspace asset/publication refs are rejected in application code.';

-- Personal captures must not create company publication_performance_snapshots.
-- The 0051 trigger matched any of the user's published posts; narrow it so the
-- capture's workspace must equal the publication workspace and that workspace
-- must be company-typed.
CREATE OR REPLACE FUNCTION link_company_publication_performance() RETURNS trigger AS $$
DECLARE publication record; snapshot_id uuid; engagement jsonb;
BEGIN
  engagement := NEW.metadata->'engagement';
  IF engagement IS NULL OR engagement = '{}'::jsonb THEN RETURN NEW; END IF;
  -- No workspace on the capture → cannot prove company boundary; skip.
  IF NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
  SELECT sp.id,sp.workspace_id,sp.content_asset_id,sp.platform INTO publication
    FROM scheduled_posts sp
    JOIN workspaces w ON w.id = sp.workspace_id AND w.workspace_type = 'company'
   WHERE sp.user_id = NEW.user_id
     AND sp.workspace_id = NEW.workspace_id
     AND sp.status = 'published'
     AND sp.content_asset_id IS NOT NULL
     AND (sp.external_url = NEW.metadata->>'url'
          OR (sp.external_id IS NOT NULL AND NEW.client_id LIKE '%'||sp.external_id||'%'))
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

COMMENT ON FUNCTION link_company_publication_performance() IS
  'Links provider engagement on a capture to a company publication only when capture.workspace_id matches the published scheduled_posts.workspace_id and that workspace is company-typed. Personal captures never create company performance snapshots. RLS deferred.';
