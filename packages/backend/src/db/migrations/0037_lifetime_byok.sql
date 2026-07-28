-- Lifetime (BYOK) plan + per-user API key storage. Additive/forward-only.
--
-- 1. The plan itself. One payment, no renewal, no caps — a lifetime user brings
--    their own LLM and scraper keys, so the spend every other plan's caps exist
--    to bound lands on THEIR account, not ours.
--    The 0001 constraint is inline+unnamed, so Postgres auto-named it
--    subscriptions_plan_check (same dance as 0025/0027).
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free','paid','scale','founding','lifetime'));

-- 2. BYOK credentials.
--
--    ENCRYPTED AT REST, always. These are live third-party API keys that bill
--    the user's own card; a plaintext column would turn any read-only leak of
--    this table into direct financial loss for every lifetime customer. Stored
--    AES-256-GCM (lib/crypto.ts) under BYOK_ENCRYPTION_KEY, which lives only in
--    the deploy env and never in the database — so a dump of this table alone is
--    inert.
--
--    `last4` is the only plaintext fragment kept, so Settings can render
--    "sk-or-…9f2c" and let the user confirm WHICH key is stored without us ever
--    showing it back. There is deliberately no endpoint that returns a full key:
--    once saved, a key can be replaced but never read out.
CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'openrouter' (all generation) | 'twitterapi' | 'apify' (X data)
  provider     text NOT NULL,
  ciphertext   text NOT NULL,   -- base64
  iv           text NOT NULL,   -- base64, 12 bytes, unique per write
  auth_tag     text NOT NULL,   -- base64, GCM integrity tag
  last4        text NOT NULL,
  -- When we last proved the key works with a real call to the provider. NULL
  -- means "saved but never validated", which the gate treats as not-yet-valid.
  validated_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- The hot path is "give me this user's key for this provider" on every model
-- call, which the primary key already covers.
