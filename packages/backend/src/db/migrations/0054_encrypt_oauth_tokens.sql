-- Encrypt OAuth posting tokens at rest (AES-256-GCM via lib/crypto.ts
-- sealForPurpose). Plaintext post_access_token / post_refresh_token stay for a
-- dual-read rollout: readers prefer *_enc columns and fall back to plaintext.
-- After the dual-read window, plaintext columns will be nulled (and eventually
-- dropped) — do not write new plaintext when OAuth encryption is configured.
ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS post_access_token_enc  text,
  ADD COLUMN IF NOT EXISTS post_access_token_iv   text,
  ADD COLUMN IF NOT EXISTS post_access_token_tag  text,
  ADD COLUMN IF NOT EXISTS post_refresh_token_enc text,
  ADD COLUMN IF NOT EXISTS post_refresh_token_iv  text,
  ADD COLUMN IF NOT EXISTS post_refresh_token_tag text;

COMMENT ON COLUMN connected_accounts.post_access_token IS
  'Legacy plaintext access token; dual-read during rollout. Will be nulled after encrypted columns are the sole source of truth.';
COMMENT ON COLUMN connected_accounts.post_refresh_token IS
  'Legacy plaintext refresh token; dual-read during rollout. Will be nulled after encrypted columns are the sole source of truth.';
