-- Free-form "Auto Agent" briefs. Alongside the two deterministic preset sources
-- (trend_ride, unlock_backlog) an automation can now be a 'custom' one the user
-- describes in their own words — the govork-style "define it freely" path. The
-- brief text seeds the same draft pipeline directly (custom source), and also
-- acts as optional extra guidance layered onto the preset sources.
-- Additive/forward-only; clean on fresh + existing.

-- Widen the source_type CHECK to allow 'custom'. The 0024 constraint is
-- inline+unnamed, so Postgres auto-named it automations_source_type_check.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_source_type_check;
ALTER TABLE automations ADD CONSTRAINT automations_source_type_check
  CHECK (source_type IN ('trend_ride','unlock_backlog','custom'));

-- The user's own words for what this automation should do. For 'custom' it is
-- the seed handed to drafting; for the presets it's optional extra guidance.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS brief text;
