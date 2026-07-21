-- "Sign in with X" identity. A web user can now be keyed by their X account id
-- (in addition to email/telegram_id), so authenticating via X both logs them in
-- and identifies the account to connect. Additive, nullable, unique.
ALTER TABLE users ADD COLUMN IF NOT EXISTS x_user_id text UNIQUE;
