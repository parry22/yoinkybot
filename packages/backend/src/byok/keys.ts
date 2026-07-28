/**
 * BYOK: the lifetime plan's own provider keys.
 *
 * The lifetime plan is one $99 payment with no caps, which only works because
 * the user funds their own model and scraper spend. That is this module: store
 * their keys encrypted, prove they work, and hand them to the gateway and the
 * scrapers so their traffic bills their account instead of ours.
 *
 * Three providers:
 *   openrouter  — every generation call (llm/gateway.ts, llm/embeddings.ts)
 *   twitterapi  — X reads (capture/imports/twitterapi-io.ts)
 *   apify       — X/LinkedIn scrapes + trends (lib/apify.ts)
 * `twitterapi` OR `apify` satisfies the scraper requirement; the gate wants one
 * of the two, not both, because either one can serve the X data path.
 *
 * A key is never readable back out. Settings shows `last4` so a user can tell
 * which key is stored; there is deliberately no endpoint returning the full
 * value. Replace, don't reveal.
 */
import { query, queryOne } from "../db/pool.js";
import { seal, open, last4, type Sealed } from "../lib/crypto.js";
import { entitlementsFor } from "../billing/entitlements.js";

export type KeyProvider = "openrouter" | "twitterapi" | "apify";
export const KEY_PROVIDERS: KeyProvider[] = ["openrouter", "twitterapi", "apify"];

interface KeyRow {
  provider: KeyProvider;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  last4: string;
  validated_at: string | null;
}

/**
 * Decrypted keys, cached in-process.
 *
 * Without this every model call would do a DB round trip plus an AES decrypt —
 * and the chat tool loop alone makes several per turn. Single-instance backend
 * (docs/INTERNAL.md §1), so a plain Map is the right cache; the TTL bounds how
 * long a rotated or deleted key keeps working. `invalidate` clears it on write
 * so a user who fixes a bad key sees it take effect immediately rather than
 * after the TTL.
 */
const cache = new Map<string, { keys: Partial<Record<KeyProvider, string>>; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function invalidate(userId: string): void {
  cache.delete(userId);
}

async function loadKeys(userId: string): Promise<Partial<Record<KeyProvider, string>>> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.keys;

  const rows = await query<KeyRow>(
    `SELECT provider, ciphertext, iv, auth_tag, last4, validated_at::text AS validated_at
     FROM user_api_keys WHERE user_id = $1`,
    [userId],
  );
  const keys: Partial<Record<KeyProvider, string>> = {};
  for (const r of rows) {
    try {
      keys[r.provider] = open({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag } satisfies Sealed);
    } catch (err) {
      // A key that won't decrypt (rotated BYOK_ENCRYPTION_KEY, corrupted row) is
      // treated as absent rather than crashing the caller's turn — the caller
      // then falls back or fails with a clear "no key" message.
      console.error(`byok: failed to decrypt ${r.provider} key for user ${userId}`, err);
    }
  }
  cache.set(userId, { keys, at: Date.now() });
  return keys;
}

/** Is this user on the BYOK (lifetime) plan? Cheap enough to call per request. */
export async function isByokUser(userId: string): Promise<boolean> {
  const ent = await entitlementsFor(userId);
  return ent.plan === "lifetime";
}

/**
 * The key this user's calls should run on, or null to use ours.
 *
 * Returns null for everyone who isn't on lifetime, so the global config key
 * keeps serving every other plan unchanged — this is deliberately a narrow
 * override, not a new default path.
 */
export async function keyForUser(userId: string | null, provider: KeyProvider): Promise<string | null> {
  if (!userId) return null;
  if (!(await isByokUser(userId))) return null;
  const keys = await loadKeys(userId);
  return keys[provider] ?? null;
}

/** Either scraper key satisfies the X-data requirement. */
export async function scraperKeyForUser(
  userId: string | null,
): Promise<{ provider: "twitterapi" | "apify"; key: string } | null> {
  if (!userId) return null;
  if (!(await isByokUser(userId))) return null;
  const keys = await loadKeys(userId);
  if (keys.twitterapi) return { provider: "twitterapi", key: keys.twitterapi };
  if (keys.apify) return { provider: "apify", key: keys.apify };
  return null;
}

export interface ByokKeyView {
  provider: KeyProvider;
  last4: string;
  validatedAt: string | null;
}

export interface ByokStatus {
  /** Whether this user is on the plan that requires BYOK at all. */
  required: boolean;
  /** True once everything the gate demands is present and validated. */
  complete: boolean;
  hasLlm: boolean;
  hasScraper: boolean;
  keys: ByokKeyView[];
}

/**
 * What the setup gate and Settings both read. `complete` is the single source of
 * truth for "may this user use the app" — see web/src/lib/byok-gate.ts.
 */
export async function byokStatus(userId: string): Promise<ByokStatus> {
  const required = await isByokUser(userId);
  const rows = await query<KeyRow>(
    `SELECT provider, ciphertext, iv, auth_tag, last4, validated_at::text AS validated_at
     FROM user_api_keys WHERE user_id = $1 ORDER BY provider`,
    [userId],
  );
  const keys = rows.map((r) => ({ provider: r.provider, last4: r.last4, validatedAt: r.validated_at }));
  // Validated, not merely present: a typo'd key that we stored but could never
  // use would otherwise unlock the app into a product that fails on every call.
  const validated = new Set(keys.filter((k) => k.validatedAt).map((k) => k.provider));
  const hasLlm = validated.has("openrouter");
  const hasScraper = validated.has("twitterapi") || validated.has("apify");
  return { required, complete: !required || (hasLlm && hasScraper), hasLlm, hasScraper, keys };
}

/**
 * Prove a key works before we accept it, with the cheapest authenticated read
 * each provider offers. An unvalidated key is worse than no key: the user
 * believes they're set up and every feature fails later, far from the cause.
 */
export async function validateKey(provider: KeyProvider, key: string): Promise<{ ok: boolean; reason?: string }> {
  const timeout = AbortSignal.timeout(15_000);
  try {
    if (provider === "openrouter") {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${key}` },
        signal: timeout,
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "OpenRouter rejected that key." };
      if (!res.ok) return { ok: false, reason: `OpenRouter returned ${res.status}.` };
      return { ok: true };
    }
    if (provider === "twitterapi") {
      // No dedicated whoami endpoint — a 1-result search is the cheapest call
      // that still exercises auth.
      const res = await fetch("https://api.twitterapi.io/twitter/tweet/advanced_search?query=hello&queryType=Latest", {
        headers: { "x-api-key": key },
        signal: timeout,
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "twitterapi.io rejected that key." };
      if (!res.ok) return { ok: false, reason: `twitterapi.io returned ${res.status}.` };
      return { ok: true };
    }
    const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`, { signal: timeout });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "Apify rejected that token." };
    if (!res.ok) return { ok: false, reason: `Apify returned ${res.status}.` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Couldn't reach ${provider} to check that key — try again.` };
  }
}

/**
 * Validate, then store encrypted. Validation runs FIRST so a bad key is never
 * persisted, and `validated_at` is only ever set by a real successful call.
 */
export async function saveKey(
  userId: string,
  provider: KeyProvider,
  rawKey: string,
): Promise<{ ok: boolean; reason?: string }> {
  const key = rawKey.trim();
  if (!key) return { ok: false, reason: "Paste a key first." };
  if (!KEY_PROVIDERS.includes(provider)) return { ok: false, reason: "Unknown provider." };

  const check = await validateKey(provider, key);
  if (!check.ok) return check;

  const sealed = seal(key);
  await query(
    `INSERT INTO user_api_keys (user_id, provider, ciphertext, iv, auth_tag, last4, validated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now(), now())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
       last4 = EXCLUDED.last4, validated_at = now(), updated_at = now()`,
    [userId, provider, sealed.ciphertext, sealed.iv, sealed.authTag, last4(key)],
  );
  invalidate(userId);
  return { ok: true };
}

/** Remove a stored key. */
export async function deleteKey(userId: string, provider: KeyProvider): Promise<{ ok: boolean }> {
  await query(`DELETE FROM user_api_keys WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  invalidate(userId);
  return { ok: true };
}

/** Count of users holding a given provider key — operator visibility only. */
export async function byokKeyCount(): Promise<number> {
  const row = await queryOne<{ n: string }>(`SELECT count(DISTINCT user_id)::text n FROM user_api_keys`);
  return Number(row?.n ?? 0);
}
