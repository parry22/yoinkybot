-- The agency working rhythm: weekly content plan, next-day performance pulse,
-- and reputation alerts — three new surfacing types.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match',
   'progress_report','reply_draft','weekly_plan','performance_alert','reputation_alert'));
