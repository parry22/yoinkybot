import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./oauth.js";
import { config } from "../config.js";

/**
 * Regression guard for the open-redirect. The original check was
 * `raw.startsWith(config.WEB_APP_URL)`, which has no authority boundary — a
 * hostile host that merely BEGINS with the trusted one sails through and the
 * user is bounced there carrying a just-completed OAuth session.
 */
const trusted = config.WEB_APP_URL; // http://localhost:3002 under test defaults
const { origin } = new URL(trusted);

describe("safeReturnTo", () => {
  it("allows a URL on the exact web app origin", () => {
    expect(safeReturnTo(`${origin}/app/settings`)).toBe(`${origin}/app/settings`);
  });

  it("allows a query string and fragment on that origin", () => {
    expect(safeReturnTo(`${origin}/app/settings?tab=plan#billing`)).toBe(`${origin}/app/settings?tab=plan#billing`);
  });

  it("drops a suffixed lookalike host (the actual bug)", () => {
    expect(safeReturnTo(`${origin}.evil.com/steal`)).toBeUndefined();
    expect(safeReturnTo(`${trusted}.attacker.example/x`)).toBeUndefined();
  });

  it("drops a different host entirely", () => {
    expect(safeReturnTo("https://evil.example/app/settings")).toBeUndefined();
  });

  it("drops a credentials-prefix trick", () => {
    expect(safeReturnTo(`https://${origin.replace(/^https?:\/\//, "")}@evil.example/`)).toBeUndefined();
  });

  it("drops a non-web scheme", () => {
    expect(safeReturnTo("javascript:alert(1)")).toBeUndefined();
    expect(safeReturnTo("data:text/html,<script>alert(1)</script>")).toBeUndefined();
  });

  it("drops a protocol-relative URL", () => {
    expect(safeReturnTo("//evil.example/app")).toBeUndefined();
  });

  it("drops garbage and absent values", () => {
    expect(safeReturnTo(undefined)).toBeUndefined();
    expect(safeReturnTo("")).toBeUndefined();
    expect(safeReturnTo("not a url")).toBeUndefined();
  });
});
