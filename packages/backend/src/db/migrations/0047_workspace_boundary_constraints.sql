-- Defense in depth for tenant boundaries. Service authorization is mandatory,
-- and these composite keys make cross-workspace provenance impossible even for
-- a mistaken internal query.

ALTER TABLE experts ADD CONSTRAINT experts_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE workspace_sources ADD CONSTRAINT workspace_sources_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE editorial_territories ADD CONSTRAINT editorial_territories_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE claim_registry ADD CONSTRAINT claim_registry_workspace_id_unique UNIQUE (workspace_id, id);

ALTER TABLE workspace_sources ADD CONSTRAINT workspace_sources_owner_same_workspace
  FOREIGN KEY (workspace_id, owner_expert_id) REFERENCES experts(workspace_id, id);
ALTER TABLE captures ADD CONSTRAINT captures_source_same_workspace
  FOREIGN KEY (workspace_id, source_id) REFERENCES workspace_sources(workspace_id, id);
ALTER TABLE captures ADD CONSTRAINT captures_speaker_same_workspace
  FOREIGN KEY (workspace_id, speaker_expert_id) REFERENCES experts(workspace_id, id);
ALTER TABLE knowledge_objects ADD CONSTRAINT knowledge_speaker_same_workspace
  FOREIGN KEY (workspace_id, speaker_expert_id) REFERENCES experts(workspace_id, id);
ALTER TABLE content_briefs ADD CONSTRAINT brief_territory_same_workspace
  FOREIGN KEY (workspace_id, territory_id) REFERENCES editorial_territories(workspace_id, id);
ALTER TABLE content_briefs ADD CONSTRAINT brief_claim_same_workspace
  FOREIGN KEY (workspace_id, primary_claim_id) REFERENCES claim_registry(workspace_id, id);
ALTER TABLE content_assets ADD CONSTRAINT asset_brief_same_workspace
  FOREIGN KEY (workspace_id, brief_id) REFERENCES content_briefs(workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE asset_reviews ADD CONSTRAINT review_asset_same_workspace
  FOREIGN KEY (workspace_id, asset_id) REFERENCES content_assets(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE content_brief_sources ADD COLUMN workspace_id uuid;
UPDATE content_brief_sources cbs SET workspace_id = cb.workspace_id
  FROM content_briefs cb WHERE cb.id = cbs.content_brief_id;
ALTER TABLE content_brief_sources ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE content_brief_sources ADD CONSTRAINT brief_source_brief_same_workspace
  FOREIGN KEY (workspace_id, content_brief_id) REFERENCES content_briefs(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE content_brief_sources ADD CONSTRAINT brief_source_knowledge_same_workspace
  FOREIGN KEY (workspace_id, knowledge_object_id) REFERENCES knowledge_objects(workspace_id, id) ON DELETE RESTRICT;
CREATE INDEX content_brief_sources_workspace ON content_brief_sources (workspace_id, content_brief_id);
