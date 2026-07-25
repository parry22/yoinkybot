/**
 * Mint the backend's scoped LiteLLM virtual key (docs/INTERNAL §3n, DEPLOY.md).
 *
 * WHY THIS EXISTS: the proxy has no public domain by design, so `/key/generate`
 * is only reachable from inside Railway's private network. `railway ssh` covers
 * that on most networks — but it needs outbound port 22 (and `railway sandbox
 * exec` needs 2226), which plenty of corporate/ISP networks block. This script
 * runs the mint from inside a Railway container instead, so the proxy never has
 * to be exposed publicly.
 *
 * It takes the key VALUE from the environment rather than letting LiteLLM
 * generate one, so the secret never has to be echoed into Railway's deploy logs
 * to be recovered. LiteLLM accepts a caller-supplied `key` (must start with
 * `sk-`); if it is absent it mints a random one instead.
 *
 * Idempotent: re-running with a key that already exists is reported and treated
 * as success, so a redeploy of the spike harness does not fail the run.
 *
 * Env: LITELLM_BASE_URL, LITELLM_MASTER_KEY, LITELLM_API_KEY (the value to mint).
 */
const BASE_URL = process.env.LITELLM_BASE_URL;
const MASTER_KEY = process.env.LITELLM_MASTER_KEY;
const KEY_VALUE = process.env.LITELLM_API_KEY;

/** The two models the backend is allowed to reach. Anything else 401s. */
const SCOPED_MODELS = ["yoinky-agent", "yoinky-agent-fallback"];

async function main() {
  if (!BASE_URL || !MASTER_KEY || !KEY_VALUE) {
    console.error("mint: need LITELLM_BASE_URL, LITELLM_MASTER_KEY and LITELLM_API_KEY");
    process.exit(2);
  }
  if (!KEY_VALUE.startsWith("sk-")) {
    console.error("mint: LITELLM_API_KEY must start with 'sk-' (LiteLLM rejects anything else)");
    process.exit(2);
  }

  const res = await fetch(`${BASE_URL}/key/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      key: KEY_VALUE,
      models: SCOPED_MODELS,
      key_alias: "yoinky-backend",
      metadata: { purpose: "agent-sdk-runtime", managed_by: "scripts/mint-litellm-key.ts" },
    }),
  });

  const text = await res.text();
  // NEVER log the body verbatim — it contains the key. Report shape only.
  if (res.ok) {
    console.log(`mint: OK — virtual key active, scoped to [${SCOPED_MODELS.join(", ")}]`);
    return;
  }
  const alreadyExists = /already exists|duplicate key|unique constraint/i.test(text);
  if (alreadyExists) {
    console.log("mint: key already exists — reusing it (no change)");
    return;
  }
  console.error(`mint: FAILED (${res.status}) ${text.replace(KEY_VALUE, "<redacted>").slice(0, 300)}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("mint: crashed:", String((e as Error).message).slice(0, 300));
  process.exit(1);
});
