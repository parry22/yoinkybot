-- Performance reporting: unlock conversions need to be attributable to a
-- reporting period, so record WHEN an item was developed, not just that it was.
-- Additive only. Existing developed rows stay NULL (developed, date unknown).

ALTER TABLE unlock_items ADD COLUMN developed_at timestamptz;
