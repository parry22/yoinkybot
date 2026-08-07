/**
 * Postgres-backed OAuth handshake state (PKCE verifier + CSRF).
 * Single-consume via DELETE … RETURNING — a replayed callback cannot redeem twice.
 */
import { randomBytes } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import type { Platform } from "./types.js";

export type OAuthStatePlatform = Platform | "web_linkedin";

export interface OAuthStateRecord {
  userId: string;
  platform: OAuthStatePlatform;
  verifier: string | null;
  returnTo: string | null;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Drop expired rows opportunistically (best-effort; consume also filters). */
async function sweepExpired(): Promise<void> {
  await query(`DELETE FROM oauth_states WHERE expires_at < now()`).catch(() => {});
}

export async function createOAuthState(input: {
  userId: string;
  platform: OAuthStatePlatform;
  verifier?: string | null;
  returnTo?: string | null;
}): Promise<string> {
  await sweepExpired();
  const state = b64url(randomBytes(16));
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  await query(
    `INSERT INTO oauth_states (state, user_id, platform, code_verifier, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [state, input.userId, input.platform, input.verifier ?? null, input.returnTo ?? null, expiresAt],
  );
  return state;
}

/** Consume once. Returns null if unknown, expired, wrong platform, or already used. */
export async function consumeOAuthState(
  state: string | undefined,
  platform: OAuthStatePlatform,
): Promise<OAuthStateRecord | null> {
  if (!state) return null;
  const row = await queryOne<{
    user_id: string;
    platform: OAuthStatePlatform;
    code_verifier: string | null;
    return_to: string | null;
  }>(
    `DELETE FROM oauth_states
      WHERE state = $1 AND platform = $2 AND expires_at >= now()
      RETURNING user_id, platform, code_verifier, return_to`,
    [state, platform],
  );
  if (!row) return null;
  return {
    userId: row.user_id,
    platform: row.platform,
    verifier: row.code_verifier,
    returnTo: row.return_to,
  };
}
