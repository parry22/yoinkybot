-- Grounded analysis: orientation classified at extraction so the outside-in
-- ratio in the diagnosis is a computed number, not a model impression.
-- Additive only. NULL = extracted before this migration (excluded from ratios).

ALTER TABLE memories ADD COLUMN orientation text
  CHECK (orientation IN ('inside_out','outside_in','neutral'));
