-- In-app feedback: the "Feedback" entry under Account (sidebar) opens a small
-- form — a Feature Request / Bug Report picker, a category that depends on that
-- choice, and a free-text message. Each submission lands here so the operator has
-- one place to read what users are asking for and hitting. Additive/forward-only.

CREATE TABLE IF NOT EXISTS feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,          -- 'feature_request' | 'bug_report'
  category   text,                   -- the dependent second-dropdown choice
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
