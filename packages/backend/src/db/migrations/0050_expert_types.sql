-- Align expert taxonomy with the Company Narrative Engine domain while preserving earlier values.
ALTER TABLE experts DROP CONSTRAINT experts_expert_type_check;
ALTER TABLE experts ADD CONSTRAINT experts_expert_type_check CHECK (expert_type IN (
  'founder','executive','product','engineering','sales','customer_success','marketing',
  'external_expert','other','subject_matter_expert','customer','partner'));
