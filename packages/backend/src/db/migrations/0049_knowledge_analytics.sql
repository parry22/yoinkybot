-- Company Narrative Engine, Phase F: immutable editorial learning records.

CREATE TABLE editorial_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  summary text NOT NULL,
  winning_territories jsonb NOT NULL DEFAULT '[]'::jsonb,
  weak_territories jsonb NOT NULL DEFAULT '[]'::jsonb,
  winning_knowledge_objects jsonb NOT NULL DEFAULT '[]'::jsonb,
  audience_quality_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  commercial_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX editorial_reviews_workspace ON editorial_reviews(workspace_id,period_end DESC,created_at DESC);
