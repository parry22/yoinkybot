-- Web app email magic-link login.
-- Web sessions themselves reuse the existing `sessions` table (0001); this only
-- adds the short-lived, single-use email login tokens that mint a session.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email);
