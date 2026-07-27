import { describe, expect, it, vi, afterEach } from "vitest";
import { mintConnectTicket, readConnectTicket } from "./connect-tickets.js";

afterEach(() => vi.useRealTimers());

describe("connect tickets", () => {
  it("resolves a freshly minted ticket to its user", () => {
    const t = mintConnectTicket("user-1", "x");
    expect(readConnectTicket(t, "x")).toBe("user-1");
  });

  it("is reusable inside the window (backing out of consent must not dead-end)", () => {
    const t = mintConnectTicket("user-1", "x");
    expect(readConnectTicket(t, "x")).toBe("user-1");
    expect(readConnectTicket(t, "x")).toBe("user-1");
  });

  it("is bound to one platform — no replay across legs", () => {
    const t = mintConnectTicket("user-1", "x");
    expect(readConnectTicket(t, "linkedin")).toBeNull();
  });

  it("rejects an unknown or absent ticket", () => {
    expect(readConnectTicket(undefined, "x")).toBeNull();
    expect(readConnectTicket("not-a-real-ticket", "x")).toBeNull();
  });

  it("rejects a raw user id — the whole point of the change", () => {
    mintConnectTicket("user-1", "x");
    expect(readConnectTicket("user-1", "x")).toBeNull();
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    const t = mintConnectTicket("user-1", "x");
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(readConnectTicket(t, "x")).toBeNull();
  });

  it("mints a distinct, high-entropy ticket each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintConnectTicket("user-1", "x")));
    expect(seen.size).toBe(50);
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(40);
  });
});
