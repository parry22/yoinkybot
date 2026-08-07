-- Keep a brief's conversion action inside its own workspace.
ALTER TABLE content_briefs
  ADD CONSTRAINT content_briefs_cta_same_workspace
  FOREIGN KEY (workspace_id, cta_id)
  REFERENCES conversion_actions(workspace_id, id)
  ON DELETE SET NULL;
