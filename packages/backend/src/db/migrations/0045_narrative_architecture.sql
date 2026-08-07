-- Company Narrative Engine, Phase C: versioned narrative architecture.

CREATE TABLE workspace_audiences (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text NOT NULL,
  role_type          text NOT NULL DEFAULT 'other' CHECK (role_type IN (
                       'end_user','champion','technical_evaluator','budget_owner',
                       'executive_approver','influencer','other')),
  description        text,
  needs              jsonb NOT NULL DEFAULT '[]'::jsonb,
  objections         jsonb NOT NULL DEFAULT '[]'::jsonb,
  success_definition text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE buyer_journey_questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  audience_id  uuid REFERENCES workspace_audiences(id) ON DELETE CASCADE,
  stage        text NOT NULL CHECK (stage IN (
                 'problem_unaware','problem_aware','solution_aware','product_aware',
                 'evaluation','purchase','adoption','advocacy')),
  question     text NOT NULL,
  priority     integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','covered','archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE narrative_systems (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded','archived')),
  category_thesis      text NOT NULL,
  problem_narrative    text NOT NULL,
  point_of_view        text NOT NULL,
  unique_mechanism     text NOT NULL,
  primary_promise      text NOT NULL,
  created_by_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, version)
);
CREATE UNIQUE INDEX narrative_systems_one_active
  ON narrative_systems (workspace_id) WHERE status = 'active';

CREATE TABLE narrative_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  narrative_system_id uuid NOT NULL REFERENCES narrative_systems(id) ON DELETE CASCADE,
  message_type        text NOT NULL CHECK (message_type IN (
                        'company','product','audience','use_case','feature','objection','competitor')),
  audience_id         uuid REFERENCES workspace_audiences(id) ON DELETE SET NULL,
  product_area        text,
  problem             text,
  cost                text,
  new_insight         text,
  mechanism           text,
  evidence_summary    text,
  desired_action      text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE editorial_territories (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  narrative_system_id  uuid NOT NULL REFERENCES narrative_systems(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  audience_problem     text,
  company_perspective  text,
  commercial_relevance text,
  proof_requirements   text,
  recurring_formats    jsonb NOT NULL DEFAULT '[]'::jsonb,
  topics_to_avoid      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX editorial_territories_workspace ON editorial_territories (workspace_id, status);

CREATE TABLE claim_registry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  knowledge_object_id   uuid NOT NULL,
  claim_text            text NOT NULL,
  risk_level            text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high','regulated')),
  approval_status       text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected','prohibited')),
  evidence_requirements text,
  approved_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  expires_at            timestamptz,
  allowed_contexts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  prohibited_contexts   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, knowledge_object_id)
    REFERENCES knowledge_objects(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, knowledge_object_id)
);

