-- Growth's Auto Agent allowance changed from five to thirty posts per
-- publishing platform. Existing agents keep their user-authored custom cap,
-- but lift the old generated default so the plan change applies immediately.
UPDATE automations
SET monthly_cap = 30, updated_at = now()
WHERE monthly_cap = 5;
