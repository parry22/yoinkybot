import { describe, expect, it } from "vitest";
import { assertHostedOAuthEncryption, oauthEncryptionKeyUsable } from "./config.js";

describe("oauthEncryptionKeyUsable", () => {
  it("accepts a valid base64 32-byte key", () => {
    expect(
      oauthEncryptionKeyUsable({
        OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toBe(true);
  });

  it("rejects missing keys", () => {
    expect(oauthEncryptionKeyUsable({})).toBe(false);
  });
});

describe("assertHostedOAuthEncryption", () => {
  it("throws in hosted production without a usable key", () => {
    expect(() =>
      assertHostedOAuthEncryption({
        NODE_ENV: "production",
        SELF_HOSTED: false,
        OAUTH_TOKEN_ENCRYPTION_KEY: "",
        BYOK_ENCRYPTION_KEY: "",
      }),
    ).toThrow(/OAUTH_TOKEN_ENCRYPTION_KEY/);
  });

  it("allows self-hosted production without a key", () => {
    expect(() =>
      assertHostedOAuthEncryption({
        NODE_ENV: "production",
        SELF_HOSTED: true,
      }),
    ).not.toThrow();
  });
});
