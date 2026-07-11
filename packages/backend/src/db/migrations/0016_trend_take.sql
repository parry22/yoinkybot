-- Macro-moment rebuild: the composed trend take is its own surfacing type with
-- distinct delivery treatment (no resurfacing reaction card), sharing the
-- unified proactive budget like everything else.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match',
   'progress_report','reply_draft','weekly_plan','performance_alert','reputation_alert',
   'nudge','trend_take'));
