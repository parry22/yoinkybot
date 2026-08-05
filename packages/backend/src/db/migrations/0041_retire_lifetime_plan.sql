-- Lifetime is no longer sold. Preserve access for any existing buyer by moving
-- the account to Scale, the highest hosted subscription tier. Keeping the old
-- enum/check value is intentional compatibility for historical webhook data;
-- checkout and intended-plan code no longer accepts new Lifetime purchases.
UPDATE subscriptions
SET plan = 'scale',
    intended_plan = CASE WHEN intended_plan = 'lifetime' THEN 'scale' ELSE intended_plan END,
    updated_at = now()
WHERE plan = 'lifetime' OR intended_plan = 'lifetime';
