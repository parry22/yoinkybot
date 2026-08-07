-- Company Narrative Engine, Phase E: campaigns, distribution and honest conversion influence.

CREATE TABLE content_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  objective text NOT NULL,
  audience_id uuid REFERENCES workspace_audiences(id) ON DELETE SET NULL,
  territory_id uuid REFERENCES editorial_territories(id) ON DELETE SET NULL,
  start_at timestamptz NOT NULL DEFAULT now(),
  end_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','archived')),
  success_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id)
);
CREATE INDEX content_campaigns_workspace ON content_campaigns(workspace_id,status,start_at DESC);

ALTER TABLE content_briefs
  ADD CONSTRAINT content_briefs_campaign_fk FOREIGN KEY (workspace_id,campaign_id)
  REFERENCES content_campaigns(workspace_id,id) ON DELETE SET NULL;

CREATE TABLE distribution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_asset_id uuid,
  campaign_id uuid,
  step_type text NOT NULL CHECK (step_type IN (
    'primary_publish','secondary_channel','founder_amplification','team_amplification',
    'partner_seeding','community_placement','sales_reuse','resurface')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended','planned','scheduled','completed','skipped')),
  instructions text NOT NULL,
  scheduled_at timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(content_asset_id,campaign_id)=1),
  FOREIGN KEY (workspace_id,content_asset_id) REFERENCES content_assets(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,campaign_id) REFERENCES content_campaigns(workspace_id,id) ON DELETE CASCADE,
  UNIQUE (workspace_id,content_asset_id,step_type),
  UNIQUE (workspace_id,campaign_id,step_type)
);
CREATE INDEX distribution_steps_workspace ON distribution_steps(workspace_id,status,created_at DESC);

CREATE TABLE conversion_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('follow','reply','subscribe','download','audit','webinar','trial','demo','contact_sales','custom')),
  destination text NOT NULL,
  commitment_level text NOT NULL CHECK (commitment_level IN ('low','medium','high')),
  tracking_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  tracking_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id)
);
CREATE INDEX conversion_actions_workspace ON conversion_actions(workspace_id,status,created_at DESC);

CREATE TABLE conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversion_action_id uuid NOT NULL,
  content_asset_id uuid,
  publication_id uuid REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  campaign_id uuid,
  external_person_id text,
  external_opportunity_id text,
  event_type text NOT NULL CHECK (event_type IN ('click','signup','download','reply','demo','lead','opportunity','revenue')),
  influence_kind text NOT NULL DEFAULT 'observed' CHECK (influence_kind IN ('observed','influenced')),
  value numeric(14,2),
  currency char(3),
  deduplication_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,conversion_action_id) REFERENCES conversion_actions(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,content_asset_id) REFERENCES content_assets(workspace_id,id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id,campaign_id) REFERENCES content_campaigns(workspace_id,id) ON DELETE SET NULL,
  UNIQUE (workspace_id,deduplication_key)
);
CREATE INDEX conversion_events_workspace ON conversion_events(workspace_id,occurred_at DESC);
CREATE INDEX conversion_events_asset ON conversion_events(workspace_id,content_asset_id,occurred_at DESC);
