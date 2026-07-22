-- Multi-automation "auto agent" (§3l). Generalizes the single global autopilot
-- (users.settings.agent_mode + one runAgentCycle) into several independent,
-- named automations, each with its own source, cadence, and delivery mode.
-- Doctrine: code decides whether/which via existing deterministic selectors; the
-- LLM only composes the draft. Additive/forward-only; clean on fresh + existing.

CREATE TABLE automations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id          uuid NOT NULL,                         -- agency prep (see 0001); == user_id in v1
  name                text NOT NULL,
  source_type         text NOT NULL CHECK (source_type IN ('trend_ride','unlock_backlog')),
  delivery_mode       text NOT NULL CHECK (delivery_mode IN ('approval','auto')),
  platform            text NOT NULL DEFAULT 'x' CHECK (platform IN ('x')),  -- LinkedIn deferred
  enabled             boolean NOT NULL DEFAULT true,
  cadence_kind        text NOT NULL DEFAULT 'daily' CHECK (cadence_kind IN ('daily','weekly','manual')),
  cadence_meta        jsonb NOT NULL DEFAULT '{}',            -- e.g. {"days":["mon"],"hour":9} in user tz
  respect_quiet_hours boolean NOT NULL DEFAULT true,
  monthly_cap         integer NOT NULL DEFAULT 30,           -- hard ceiling on posts/month
  pillar_scope        jsonb,                                 -- optional subset of pillars; null = all
  warmup_count        integer NOT NULL DEFAULT 0,            -- auto posts that have gone out (for the warmup ramp)
  last_run_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_automations_user ON automations (user_id);
CREATE INDEX idx_automations_due ON automations (enabled, cadence_kind);

-- One row per fire: lifecycle + dedup ledger + tuning surface. Every status
-- transition that gates real work is an atomic claim
-- (UPDATE ... WHERE id=$1 AND status=$expected RETURNING), so a duplicate tick,
-- double callback tap, or redelivered job can never double-draft/DM/post.
CREATE TABLE automation_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id     uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized for cheap per-user caps
  status            text NOT NULL DEFAULT 'drafting' CHECK (status IN (
                      'drafting','awaiting_approval','approved','scheduled','posted',
                      'rejected','edited','failed','skipped')),
  source_ref        jsonb,        -- what the deterministic selector picked (trend id/url/note, or unlock id)
  draft_body        text,         -- feed content: POST_WRITING_RULES + enforceStyle, NEVER casualized
  media_suggestion  text,
  agent_steps       jsonb,        -- draft grounding trail, inspectable
  scheduled_post_id uuid,         -- set once queued into scheduled_posts
  verdict_reason    text,         -- why skipped/failed/rejected (human-readable)
  edit_count        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_automation_runs_automation ON automation_runs (automation_id, created_at DESC);
CREATE INDEX idx_automation_runs_user ON automation_runs (user_id, created_at DESC);
CREATE INDEX idx_automation_runs_pending ON automation_runs (user_id, status);

-- D1: subsume the retired single autopilot. Every user who had agent_mode on
-- becomes one 'unlock backlog' automation in auto mode (the old behavior was
-- draft-then-schedule-ahead, which is exactly delayed/cancellable auto mode).
-- It stays paused in practice until AUTOMATIONS_AUTO_ENABLED is flipped on, so no
-- unattended post fires from a migration. The agent_mode flag is left in settings
-- (harmless) once the old tick is retired.
INSERT INTO automations (user_id, profile_id, name, source_type, delivery_mode, cadence_kind)
SELECT id, id, 'Post from my backlog', 'unlock_backlog', 'auto', 'daily'
FROM users
WHERE (settings->>'agent_mode')::boolean IS TRUE;
