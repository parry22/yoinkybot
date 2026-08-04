-- LinkedIn is now a first-class publishing target for Auto Agent, and a
-- repurposed draft retains the staged media copied from its source X post.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_platform_check;
ALTER TABLE automations
  ADD CONSTRAINT automations_platform_check CHECK (platform IN ('x','linkedin'));

ALTER TABLE connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_status_check;
ALTER TABLE connected_accounts
  ADD CONSTRAINT connected_accounts_status_check
  CHECK (status IN ('pending','ingesting','ingested','failed','posting_connected'));

ALTER TABLE repurposed_content
  ADD COLUMN IF NOT EXISTS media_ids uuid[] NOT NULL DEFAULT '{}';
