/**
 * Authenticated symmetric encryption for secrets we must be able to read back -
 * BYOK provider keys (byok/keys.ts) and OAuth posting tokens (social/token-crypto.ts).
 *
 * AES-256-GCM, not AES-CBC or a bare cipher: GCM is AEAD, so decryption FAILS
 * on tampered ciphertext instead of silently returning garbage that we would
 * then send to a provider as if it were the user's key. The auth tag is stored
 * alongside and verified on every read.
 *
 * Keys live in deploy env only (never the database):
 *   - BYOK_ENCRYPTION_KEY — required for BYOK seal/open
 *   - OAUTH_TOKEN_ENCRYPTION_KEY — optional dedicated key for OAuth tokens;
 *     falls back to BYOK_ENCRYPTION_KEY when unset (same master key, purpose-
 *     bound via AAD so a BYOK ciphertext cannot be opened as an OAuth token)
 *
 * A fresh 32-byte key:
 *   openssl rand -base64 32
 *
 * WHY THIS FAILS LOUDLY. Every function here throws when the key is missing or
 * malformed rather than degrading to plaintext. Silently storing a live,
 * user-billable API key or OAuth token in the clear because an env var was
 * forgotten is exactly the failure that must never be recoverable-by-accident.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

export interface Sealed {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

/**
 * Decode and validate a 32-byte master key from env. Accepts base64 or hex so an
 * operator can paste whichever `openssl rand` form they generated.
 */
function decodeKey(raw: string, envName: string): Buffer {
  // Hex first (a 64-char hex string is also valid base64-ish input, and
  // mis-decoding it would silently yield the wrong key length).
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${envName} must decode to ${KEY_BYTES} bytes (got ${buf.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return buf;
}

/**
 * The 32-byte master key for BYOK seal/open.
 */
function masterKey(): Buffer {
  const raw = config.BYOK_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "BYOK_ENCRYPTION_KEY is not set - refusing to handle user API keys without encryption. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return decodeKey(raw, "BYOK_ENCRYPTION_KEY");
}

/**
 * Master key for purpose-bound seal/open (OAuth tokens). Prefers a dedicated
 * OAUTH_TOKEN_ENCRYPTION_KEY; otherwise reuses BYOK_ENCRYPTION_KEY.
 */
function oauthMasterKey(): Buffer {
  const dedicated = config.OAUTH_TOKEN_ENCRYPTION_KEY?.trim();
  if (dedicated) return decodeKey(dedicated, "OAUTH_TOKEN_ENCRYPTION_KEY");
  const fallback = config.BYOK_ENCRYPTION_KEY?.trim();
  if (!fallback) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY (or BYOK_ENCRYPTION_KEY) is not set - refusing to handle OAuth tokens without encryption. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return decodeKey(fallback, "BYOK_ENCRYPTION_KEY");
}

/** True when BYOK encryption is usable - for boot-time config warnings, not for
 *  deciding whether to store something in the clear. */
export function encryptionConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/** True when OAuth token encryption is usable (dedicated or BYOK fallback key). */
export function oauthEncryptionConfigured(): boolean {
  try {
    oauthMasterKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a secret. A fresh random IV per call - reusing a GCM nonce under the
 *  same key is catastrophic, so it is never derived from the plaintext or the user. */
export function seal(plaintext: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt. Throws if the key is wrong or the record was tampered with. */
export function open(sealed: Sealed): string {
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Encrypt with AAD bound to `purpose` so ciphertext sealed for one purpose
 * cannot be opened under another (e.g. BYOK vs oauth.access). Uses the OAuth
 * master key (OAUTH_TOKEN_ENCRYPTION_KEY ?? BYOK_ENCRYPTION_KEY).
 */
export function sealForPurpose(purpose: string, plaintext: string): Sealed {
  if (!purpose) throw new Error("sealForPurpose requires a non-empty purpose");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, oauthMasterKey(), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt a purpose-bound sealed secret. Throws on wrong purpose, key, or tamper. */
export function openForPurpose(purpose: string, sealed: Sealed): string {
  if (!purpose) throw new Error("openForPurpose requires a non-empty purpose");
  const decipher = createDecipheriv(ALGO, oauthMasterKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(purpose, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** The only fragment of a secret we ever store or show in plaintext, so a user
 *  can tell WHICH key is saved without us handing it back. */
export function last4(secret: string): string {
  return secret.slice(-4);
}
