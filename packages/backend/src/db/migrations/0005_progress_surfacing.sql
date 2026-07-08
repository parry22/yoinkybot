-- The strategist's periodic progress read is delivered as a surfacing.
ALTER TABLE surfacings DROP CONSTRAINT surfacings_type_check;
ALTER TABLE surfacings ADD CONSTRAINT surfacings_type_check CHECK (type IN
  ('resurface','consistency_flag','macro_match','angle_offer','trend_match','progress_report'));
