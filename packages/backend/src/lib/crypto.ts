/**
 * Authenticated symmetric encryption for secrets we must be able to read back —
 * today that is BYOK provider keys (byok/keys.ts).
 *
 * AES-256-GCM, not AES-CBC or a bare cipher: GCM is AEAD, so decryption FAILS
 * on tampered ciphertext instead of silently returning garbage that we would
 * then send to a provider as if it were the user's key. The auth tag is stored
 * alongside and verified on every read.
 *
 * The key lives in BYOK_ENCRYPTION_KEY (deploy env only, never the database), so
 * a dump of `user_api_keys` on its own is inert. A fresh 32-byte key:
 *   openssl rand -base64 32
 *
 * WHY THIS FAILS LOUDLY. Every function here throws when the key is missing or
 * malformed rather than degrading to plaintext. Silently storing a live,
 * user-billable API key in the clear because an env var was forgotten is exactly
 * the failure that must never be recoverable-by-accident.
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
 * The 32-byte master key, decoded and validated. Accepts base64 or hex so an
 * operator can paste whichever `openssl rand` form they generated.
 */
function masterKey(): Buffer {
  const raw = config.BYOK_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "BYOK_ENCRYPTION_KEY is not set — refusing to handle user API keys without encryption. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  // Hex first (a 64-char hex string is also valid base64-ish input, and
  // mis-decoding it would silently yield the wrong key length).
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `BYOK_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return buf;
}

/** True when encryption is usable — for boot-time config warnings, not for
 *  deciding whether to store something in the clear. */
export function encryptionConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a secret. A fresh random IV per call — reusing a GCM nonce under the
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

/** The only fragment of a secret we ever store or show in plaintext, so a user
 *  can tell WHICH key is saved without us handing it back. */
export function last4(secret: string): string {
  return secret.slice(-4);
}
