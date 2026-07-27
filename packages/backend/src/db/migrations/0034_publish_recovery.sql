-- Publishing recovery: make a stalled publish recoverable, and make a dead
-- posting credential visible instead of silently 401-ing forever. Additive only.

-- How many times a scheduled post has been claimed for publishing.
--
-- WHY: the publish path claims a row atomically (pending → publishing). If the
-- process died — or pg-boss expired the job — between that claim and a terminal
-- write, the row stayed at 'publishing' forever: the retry's claim requires
-- status='pending', so it no-opped, `error` stayed NULL, no DM was sent and the
-- post never went out. The reaper (jobs/scheduled-post.ts) now returns those
-- rows to 'pending', and this counter is what stops a genuinely poisonous post
-- (one that crashes the worker every time) from looping between the two states
-- for eternity.
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;

-- The reaper scans only rows sitting in 'publishing'; a partial index keeps that
-- sweep off the (much larger) history of published/failed rows.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_publishing
  ON scheduled_posts (updated_at) WHERE status = 'publishing';

-- When the stored posting credential stopped working and only the user can fix
-- it (re-consent). Set when a refresh token is rejected, or when the platform
-- answers a publish/upload with 401; cleared once a usable token is stored again.
--
-- WHY: X's OAuth 2.0 user-context access tokens last ~2 hours. Until now nothing
-- read post_refresh_token or post_token_expires_at at all — the publisher used
-- whatever access token was stored on the day the user connected, so essentially
-- every scheduled X post more than two hours after connect failed with a 401 and
-- the user was told only "post rejected". The refresh flow now runs before every
-- publish; this column carries the one case refresh can't fix.
ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS post_reauth_required_at timestamptz;
