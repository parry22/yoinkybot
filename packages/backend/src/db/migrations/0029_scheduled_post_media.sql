-- Media on scheduled posts: images and video, attached in the web calendar and
-- uploaded to the platform at publish time. Additive only.

-- One row per attachment. A separate table rather than columns on
-- scheduled_posts because X allows up to 4 images on a single post, and the
-- ordering matters (it's the order they appear in the tweet).
--
--   * url        — the Vercel Blob public URL. The publisher (on Railway) fetches
--                  this with a plain GET at publish time; it holds no bytes here,
--                  so Postgres never carries a video.
--   * blob_path  — the Blob pathname, kept so a canceled/expired post's media can
--                  be deleted from storage later without parsing the URL.
--   * kind       — 'image' | 'gif' | 'video'. Drives which upload path the
--                  publisher takes (simple vs chunked) and the platform's own
--                  "one video OR up to four images" rule.
--   * external_media_id — the platform's media id once uploaded, so a retry after
--                  a partial failure doesn't re-upload the same bytes.
CREATE TABLE scheduled_post_media (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_post_id uuid NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position          integer NOT NULL DEFAULT 0,
  kind              text NOT NULL CHECK (kind IN ('image','gif','video')),
  url               text NOT NULL,
  blob_path         text,
  mime_type         text NOT NULL,
  byte_size         bigint NOT NULL,
  -- Accessibility text. X and LinkedIn both accept it; absent is allowed.
  alt_text          text,
  external_media_id text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_scheduled_post_media_post ON scheduled_post_media (scheduled_post_id, position);
CREATE INDEX idx_scheduled_post_media_user ON scheduled_post_media (user_id, created_at DESC);

-- Uploads land in Blob BEFORE the post row exists (the user picks a file while
-- still writing the text), so they need somewhere to live until the post is
-- saved. This is that staging area: rows with a NULL scheduled_post_id are
-- orphans, sweepable after a day.
ALTER TABLE scheduled_post_media
  ALTER COLUMN scheduled_post_id DROP NOT NULL;
