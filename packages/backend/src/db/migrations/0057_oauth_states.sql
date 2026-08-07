-- Single-use OAuth PKCE/CSRF state + durable connect tickets.
-- Replaces the in-memory Maps in routes/oauth.ts and lib/connect-tickets.ts
-- so a process restart (or a second replica, if ever allowed) cannot mint
-- state the callback cannot redeem — and state cannot be replayed.

CREATE TABLE IF NOT EXISTS oauth_states (
  state          text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform       text NOT NULL CHECK (platform IN ('x', 'linkedin', 'web_linkedin')),
  code_verifier  text,
  return_to      text,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);

COMMENT ON TABLE oauth_states IS
  'One-time OAuth handshake state. Consumed with DELETE … RETURNING; never reusable.';

CREATE TABLE IF NOT EXISTS oauth_connect_tickets (
  ticket      text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('x', 'linkedin')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_connect_tickets_expires_idx ON oauth_connect_tickets (expires_at);

COMMENT ON TABLE oauth_connect_tickets IS
  'Opaque connect tickets for /oauth/:platform/start. Reusable inside the TTL so backing out of consent is not a dead end; bound to one platform.';
