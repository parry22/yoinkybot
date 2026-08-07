import { describe, expect, it, vi, beforeEach } from "vitest";

const store = new Map<string, { userId: string; platform: string; expiresAt: Date }>();

vi.mock("../db/pool.js", () => ({
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("DELETE FROM oauth_connect_tickets WHERE expires_at")) {
      const now = Date.now();
      for (const [k, v] of store) if (v.expiresAt.getTime() < now) store.delete(k);
      return { rowCount: 0, rows: [] };
    }
    if (sql.startsWith("INSERT INTO oauth_connect_tickets")) {
      const [ticket, userId, platform, expiresAt] = params as [string, string, string, string];
      store.set(ticket, { userId, platform, expiresAt: new Date(expiresAt) });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM oauth_connect_tickets")) {
      const [ticket, platform] = params as [string, string];
      const row = store.get(ticket);
      if (!row || row.platform !== platform || row.expiresAt.getTime() < Date.now()) return null;
      return { user_id: row.userId };
    }
    return null;
  }),
}));

const { mintConnectTicket, readConnectTicket } = await import("./connect-tickets.js");

beforeEach(() => store.clear());

describe("connect tickets (Postgres-backed)", () => {
  it("resolves a freshly minted ticket to its user", async () => {
    const t = await mintConnectTicket("user-1", "x");
    expect(await readConnectTicket(t, "x")).toBe("user-1");
  });

  it("is reusable inside the window (backing out of consent must not dead-end)", async () => {
    const t = await mintConnectTicket("user-1", "x");
    expect(await readConnectTicket(t, "x")).toBe("user-1");
    expect(await readConnectTicket(t, "x")).toBe("user-1");
  });

  it("is bound to one platform — no replay across legs", async () => {
    const t = await mintConnectTicket("user-1", "x");
    expect(await readConnectTicket(t, "linkedin")).toBeNull();
  });

  it("rejects an unknown or absent ticket", async () => {
    expect(await readConnectTicket(undefined, "x")).toBeNull();
    expect(await readConnectTicket("not-a-real-ticket", "x")).toBeNull();
  });

  it("rejects a raw user id — the whole point of the change", async () => {
    await mintConnectTicket("user-1", "x");
    expect(await readConnectTicket("user-1", "x")).toBeNull();
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    const t = await mintConnectTicket("user-1", "x");
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(await readConnectTicket(t, "x")).toBeNull();
    vi.useRealTimers();
  });

  it("mints a distinct, high-entropy ticket each time", async () => {
    const seen = new Set(
      await Promise.all(Array.from({ length: 50 }, () => mintConnectTicket("user-1", "x"))),
    );
    expect(seen.size).toBe(50);
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(40);
  });
});
