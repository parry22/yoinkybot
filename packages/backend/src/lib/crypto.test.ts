import { describe, expect, it, beforeAll } from "vitest";

// A fixed 32-byte key, set BEFORE config.ts is imported (it parses env at module
// load). base64 of 32 zero-ish bytes is fine for a round-trip test.
beforeAll(() => {
  process.env.BYOK_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

const load = async () => import("./crypto.js");

describe("seal/open (AES-256-GCM)", () => {
  it("round-trips a secret", async () => {
    const { seal, open } = await load();
    const secret = "sk-or-v1-abcdef0123456789";
    expect(open(seal(secret))).toBe(secret);
  });

  it("never emits the plaintext in the sealed record", async () => {
    const { seal } = await load();
    const secret = "sk-or-v1-supersecrettoken";
    const sealed = seal(secret);
    for (const field of [sealed.ciphertext, sealed.iv, sealed.authTag]) {
      expect(field).not.toContain(secret);
      expect(Buffer.from(field, "base64").toString("utf8")).not.toContain(secret);
    }
  });

  /** A reused GCM nonce under one key is catastrophic, so this is load-bearing. */
  it("uses a fresh IV per call, so identical plaintexts differ", async () => {
    const { seal } = await load();
    const a = seal("same-secret");
    const b = seal("same-secret");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  /** The whole reason for AEAD: tampering must FAIL, not silently decrypt to
   *  garbage we'd then send to a provider as the user's key. */
  it("refuses tampered ciphertext instead of returning garbage", async () => {
    const { seal, open } = await load();
    const sealed = seal("sk-or-v1-abcdef0123456789");
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => open({ ...sealed, ciphertext: bytes.toString("base64") })).toThrow();
  });

  it("refuses a tampered auth tag", async () => {
    const { seal, open } = await load();
    const sealed = seal("sk-or-v1-abcdef0123456789");
    const tag = Buffer.from(sealed.authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;
    expect(() => open({ ...sealed, authTag: tag.toString("base64") })).toThrow();
  });

  it("last4 exposes only the tail", async () => {
    const { last4 } = await load();
    expect(last4("sk-or-v1-abcdef0123456789")).toBe("6789");
  });
});
