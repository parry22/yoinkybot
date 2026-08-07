-- Company Narrative Engine, Phase A: organization, workspace and expert tenancy.
--
-- This layer is deliberately additive. Existing user_id ownership remains in
-- place while workspace-aware domains are introduced, which keeps every
-- personal creator workflow working during the migration.

CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  organization_type  text NOT NULL DEFAULT 'company'
                     CHECK (organization_type IN ('personal','company')),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One private organization anchors each user's backwards-compatible personal
-- workspace. Company organizations are unrestricted.
CREATE UNIQUE INDEX organizations_one_personal_per_user
  ON organizations (created_by_user_id)
  WHERE organization_type = 'personal';

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL
                   CHECK (role IN ('owner','admin','strategist','editor','contributor','viewer')),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user ON organization_members (user_id, joined_at DESC);

CREATE TABLE workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  slug               text NOT NULL,
  workspace_type     text NOT NULL DEFAULT 'company'
                     CHECK (workspace_type IN ('personal','company')),
  description        text,
  primary_objective  text,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  settings           jsonb NOT NULL DEFAULT '{"approval_mode":"review_required"}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);
CREATE INDEX workspaces_organization ON workspaces (organization_id, created_at DESC);
CREATE UNIQUE INDEX workspaces_one_personal_per_organization
  ON workspaces (organization_id)
  WHERE workspace_type = 'personal';

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL
               CHECK (role IN ('owner','admin','strategist','editor','contributor','viewer')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id, joined_at DESC);

CREATE TABLE experts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  linked_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name           text NOT NULL,
  title          text,
  expert_type    text NOT NULL DEFAULT 'subject_matter_expert'
                 CHECK (expert_type IN ('founder','executive','subject_matter_expert','customer','partner')),
  bio            text,
  is_default     boolean NOT NULL DEFAULT false,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX experts_workspace ON experts (workspace_id, created_at DESC);
CREATE UNIQUE INDEX experts_one_default_per_workspace
  ON experts (workspace_id)
  WHERE is_default;
CREATE UNIQUE INDEX experts_one_link_per_workspace
  ON experts (workspace_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;

ALTER TABLE users ADD COLUMN active_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

