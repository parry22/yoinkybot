-- Short-term conversational memory for the Telegram assistant, so Yoinky holds
-- a real multi-turn conversation instead of treating each message in isolation.

CREATE TABLE chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user','assistant')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_user ON chat_messages (user_id, created_at DESC);
