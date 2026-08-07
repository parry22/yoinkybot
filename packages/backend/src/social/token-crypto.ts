/**
 * Encrypt / decrypt OAuth posting tokens on connected_accounts.
 *
 * Writers use encryptToken + tokenWriteParams when OAuth encryption is
 * configured (clears plaintext). Readers use decryptToken, which prefers the
 * encrypted columns and falls back to legacy plaintext during dual-read rollout.
 */
import { oauthEncryptionConfigured, openForPurpose, sealForPurpose } from "../lib/crypto.js";

const PURPOSE_ACCESS = "oauth.access";
const PURPOSE_REFRESH = "oauth.refresh";

export interface SealedTokenFields {
  enc: string;
  iv: string;
  tag: string;
}

/** Row shape used by decryptToken — plaintext and/or encrypted columns. */
export interface TokenRow {
  post_access_token?: string | null;
  post_access_token_enc?: string | null;
  post_access_token_iv?: string | null;
  post_access_token_tag?: string | null;
  post_refresh_token?: string | null;
  post_refresh_token_enc?: string | null;
  post_refresh_token_iv?: string | null;
  post_refresh_token_tag?: string | null;
}

/** Params for INSERT/UPDATE of access (+ optional refresh) token columns. */
export interface TokenWriteParams {
  post_access_token: string | null;
  post_access_token_enc: string | null;
  post_access_token_iv: string | null;
  post_access_token_tag: string | null;
  post_refresh_token: string | null;
  post_refresh_token_enc: string | null;
  post_refresh_token_iv: string | null;
  post_refresh_token_tag: string | null;
}

export function encryptToken(plaintext: string, purpose: "access" | "refresh" = "access"): SealedTokenFields {
  const sealed = sealForPurpose(purpose === "refresh" ? PURPOSE_REFRESH : PURPOSE_ACCESS, plaintext);
  return { enc: sealed.ciphertext, iv: sealed.iv, tag: sealed.authTag };
}

function openSealed(
  purpose: string,
  enc: string | null | undefined,
  iv: string | null | undefined,
  tag: string | null | undefined,
): string | null {
  if (!enc || !iv || !tag) return null;
  return openForPurpose(purpose, { ciphertext: enc, iv, authTag: tag });
}

/**
 * Prefer encrypted columns; fall back to legacy plaintext for dual-read.
 * Returns nulls when neither form is present.
 */
export function decryptToken(row: TokenRow): { accessToken: string | null; refreshToken: string | null } {
  let accessToken: string | null = null;
  if (row.post_access_token_enc) {
    accessToken = openSealed(
      PURPOSE_ACCESS,
      row.post_access_token_enc,
      row.post_access_token_iv,
      row.post_access_token_tag,
    );
  } else if (row.post_access_token) {
    accessToken = row.post_access_token;
  }

  let refreshToken: string | null = null;
  if (row.post_refresh_token_enc) {
    refreshToken = openSealed(
      PURPOSE_REFRESH,
      row.post_refresh_token_enc,
      row.post_refresh_token_iv,
      row.post_refresh_token_tag,
    );
  } else if (row.post_refresh_token) {
    refreshToken = row.post_refresh_token;
  }

  return { accessToken, refreshToken };
}

/** True when the row has a usable access token (encrypted or legacy plaintext). */
export function hasAccessToken(row: TokenRow): boolean {
  return !!(row.post_access_token_enc || row.post_access_token);
}

/**
 * Build DB write fields for an access (+ optional refresh) token.
 * When encryption is configured: sealed columns filled, plaintext nulled.
 * Otherwise: plaintext filled, encrypted columns nulled (local/dev without key).
 */
export function tokenWriteParams(
  accessToken: string,
  refreshToken?: string | null,
): TokenWriteParams {
  if (oauthEncryptionConfigured()) {
    const access = encryptToken(accessToken, "access");
    const refresh = refreshToken ? encryptToken(refreshToken, "refresh") : null;
    return {
      post_access_token: null,
      post_access_token_enc: access.enc,
      post_access_token_iv: access.iv,
      post_access_token_tag: access.tag,
      post_refresh_token: null,
      post_refresh_token_enc: refresh?.enc ?? null,
      post_refresh_token_iv: refresh?.iv ?? null,
      post_refresh_token_tag: refresh?.tag ?? null,
    };
  }
  return {
    post_access_token: accessToken,
    post_access_token_enc: null,
    post_access_token_iv: null,
    post_access_token_tag: null,
    post_refresh_token: refreshToken ?? null,
    post_refresh_token_enc: null,
    post_refresh_token_iv: null,
    post_refresh_token_tag: null,
  };
}

/** Null all access/refresh token columns (plaintext + encrypted). */
export function clearedTokenParams(): TokenWriteParams {
  return {
    post_access_token: null,
    post_access_token_enc: null,
    post_access_token_iv: null,
    post_access_token_tag: null,
    post_refresh_token: null,
    post_refresh_token_enc: null,
    post_refresh_token_iv: null,
    post_refresh_token_tag: null,
  };
}
