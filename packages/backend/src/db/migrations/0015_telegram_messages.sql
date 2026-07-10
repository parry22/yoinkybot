-- Tracks every Telegram message (incoming and outgoing) by chat_id + message_id
-- so /clear can delete the visible chat history, not just the derived data.
-- Telegram gives bots no "list messages in a chat" API, so this has to be
-- recorded as messages happen; it cannot be backfilled for history that
-- predates this migration. Additive.
CREATE TABLE telegram_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     bigint NOT NULL,
  message_id  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_telegram_messages_user ON telegram_messages (user_id);
