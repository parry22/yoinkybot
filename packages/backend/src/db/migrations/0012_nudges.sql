-- Structural nudges + the cold-start first touch: the proactive engine's
-- fallback outcomes for the early sparse-data window, delivered as surfacings
-- so they share the unified budget and show up in history like everything else.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match',
   'progress_report','reply_draft','weekly_plan','performance_alert','reputation_alert',
   'nudge'));
