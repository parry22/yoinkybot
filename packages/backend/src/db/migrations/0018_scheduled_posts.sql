-- Native social scheduling: queue a post now, publish it to X/LinkedIn at a
-- chosen time. Additive only.

-- The scheduled queue. One row per scheduled post; the pg-boss job fires at
-- scheduled_for and re-reads status here, so cancelling is just a status flip
-- (no need to reach into pg-boss to kill the delayed job).
CREATE TABLE scheduled_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('x','linkedin')),
  content       text NOT NULL,
  -- Provenance when the post came from a generated draft; NULL for ad-hoc text.
  draft_id      uuid REFERENCES drafts(id) ON DELETE SET NULL,
  scheduled_for timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','publishing','published','failed','canceled')),
  external_id   text,          -- the tweet / share id once published
  external_url  text,          -- permalink, for the confirmation DM
  error         text,          -- failure reason, surfaced verbatim to the user
  job_id        text,          -- pg-boss job id (bookkeeping / future hard-cancel)
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_scheduled_posts_user ON scheduled_posts (user_id, scheduled_for DESC);
CREATE INDEX idx_scheduled_posts_pending ON scheduled_posts (status, scheduled_for);

-- Write auth. connected_accounts was read-only until now (handle + scrape
-- status). Publishing needs a user-context OAuth token per platform, obtained
-- through the write-scope OAuth flow (routes/oauth.ts). Stored here alongside
-- the existing read connection so there's still one row per (user, platform).
--   * post_author_urn: LinkedIn requires the member URN (urn:li:person:…) as the
--     post author; X posts as whoever the token belongs to, so it's LinkedIn-only.
ALTER TABLE connected_accounts
  ADD COLUMN post_access_token     text,
  ADD COLUMN post_refresh_token    text,
  ADD COLUMN post_token_expires_at timestamptz,
  ADD COLUMN post_scopes           text,
  ADD COLUMN post_author_urn       text;
