-- Grok 4.5 cost/cache instrumentation (cost-optimization spec §7).
-- Cached input bills ~4x cheaper than fresh input, so a usage row that doesn't
-- record the cached fraction systematically OVERSTATES spend — which would make
-- usage_events useless for judging whether the cache work paid off.
-- Additive + nullable + NO backfill: old rows read as "cached count unknown",
-- which is honest (we genuinely don't know their cached split).
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cached_input_tokens integer;

-- Which reasoning effort produced this call's output tokens. Reasoning tokens
-- bill at the output rate, so without this we can't attribute a cost regression
-- to an effort setting.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS reasoning_effort text;
