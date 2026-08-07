import { describe, expect, it, vi, beforeEach } from "vitest";

const store = new Map<
  string,
  { userId: string; platform: string; verifier: string | null; returnTo: string | null; expiresAt: Date }
>();

vi.mock("../db/pool.js", () => ({
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("DELETE FROM oauth_states WHERE expires_at")) {
      const now = Date.now();
      for (const [k, v] of store) if (v.expiresAt.getTime() < now) store.delete(k);
      return { rowCount: 0, rows: [] };
    }
    if (sql.startsWith("INSERT INTO oauth_states")) {
      const [state, userId, platform, verifier, returnTo, expiresAt] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
      ];
      store.set(state, {
        userId,
        platform,
        verifier,
        returnTo,
        expiresAt: new Date(expiresAt),
      });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("DELETE FROM oauth_states")) {
      const [state, platform] = params as [string, string];
      const row = store.get(state);
      if (!row || row.platform !== platform || row.expiresAt.getTime() < Date.now()) return null;
      store.delete(state);
      return {
        user_id: row.userId,
        platform: row.platform,
        code_verifier: row.verifier,
        return_to: row.returnTo,
      };
    }
    return null;
  }),
}));

const { createOAuthState, consumeOAuthState } = await import("./oauth-state.js");

beforeEach(() => store.clear());

describe("oauth state (single-consume)", () => {
  it("round-trips a freshly created state", async () => {
    const state = await createOAuthState({
      userId: "11111111-1111-1111-1111-111111111111",
      platform: "x",
      verifier: "pkce-verifier",
      returnTo: "https://app.example/settings",
    });
    const pend = await consumeOAuthState(state, "x");
    expect(pend).toEqual({
      userId: "11111111-1111-1111-1111-111111111111",
      platform: "x",
      verifier: "pkce-verifier",
      returnTo: "https://app.example/settings",
    });
  });

  it("refuses a second consume (replay)", async () => {
    const state = await createOAuthState({
      userId: "11111111-1111-1111-1111-111111111111",
      platform: "linkedin",
    });
    expect(await consumeOAuthState(state, "linkedin")).not.toBeNull();
    expect(await consumeOAuthState(state, "linkedin")).toBeNull();
  });

  it("refuses the wrong platform", async () => {
    const state = await createOAuthState({
      userId: "11111111-1111-1111-1111-111111111111",
      platform: "web_linkedin",
    });
    expect(await consumeOAuthState(state, "linkedin")).toBeNull();
  });

  it("supports web_x platform", async () => {
    const state = await createOAuthState({
      userId: "11111111-1111-1111-1111-111111111111",
      platform: "web_x",
      verifier: "pkce-verifier",
    });
    expect(await consumeOAuthState(state, "web_x")).toEqual({
      userId: "11111111-1111-1111-1111-111111111111",
      platform: "web_x",
      verifier: "pkce-verifier",
      returnTo: null,
    });
  });
});
