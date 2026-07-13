import { describe, expect, it } from "vitest";
import { whitelistIncludes } from "./entitlements.js";

describe("whitelistIncludes", () => {
  it("exempts the admin id even when the whitelist is empty", () => {
    expect(whitelistIncludes("123", undefined, "123")).toBe(true);
    expect(whitelistIncludes("123", "", "123")).toBe(true);
  });

  it("exempts any id listed in the comma-separated whitelist", () => {
    expect(whitelistIncludes("456", "111, 456 ,789", undefined)).toBe(true);
    expect(whitelistIncludes("789", "111,456,789", "999")).toBe(true);
  });

  it("does not exempt an id that is neither admin nor whitelisted", () => {
    expect(whitelistIncludes("222", "111,333", "999")).toBe(false);
  });

  it("returns false for a missing telegram id", () => {
    expect(whitelistIncludes(null, "111", "999")).toBe(false);
    expect(whitelistIncludes(undefined, "111", "999")).toBe(false);
  });

  it("tolerates whitespace and matches on exact id, not substring", () => {
    expect(whitelistIncludes(" 123 ", " 123 ", undefined)).toBe(true);
    expect(whitelistIncludes("12", "123", undefined)).toBe(false); // no substring match
  });
});
