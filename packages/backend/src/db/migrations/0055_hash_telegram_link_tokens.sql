-- Store SHA-256 of Telegram deep-link tokens (same pattern as login_tokens),
-- not the raw token. In-flight unused tokens (15m TTL) become unusable — acceptable.
ALTER TABLE telegram_link_tokens RENAME COLUMN token TO token_hash;
COMMENT ON COLUMN telegram_link_tokens.token_hash IS
  'SHA-256 hex of the one-time link token; raw token is returned once at mint and never stored.';
