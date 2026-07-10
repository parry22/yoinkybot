-- The three-month plan (Stage 11) adds a repositioning statement and a
-- month-by-month roadmap on top of the durable throughline/unlock/cadence. Stored
-- as one jsonb blob so the plan primitives (throughline, cadence, unlock_items)
-- stay unchanged. Additive.
ALTER TABLE brand_plans ADD COLUMN roadmap jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Shape: { repositioning: text, months: [{ label, objective }] }
