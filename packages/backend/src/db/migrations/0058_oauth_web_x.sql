-- Allow web X OAuth state (Clerk session + PKCE, same pattern as web_linkedin).
ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_platform_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_platform_check
  CHECK (platform IN ('x', 'linkedin', 'web_linkedin', 'web_x'));
