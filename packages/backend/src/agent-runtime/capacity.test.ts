import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The semaphore is the whole reason SDK mode fits on the current Railway plan,
 * so its two failure modes are worth pinning: letting more subprocesses run than
 * configured, and leaking a slot so the pool drains to zero over time.
 */

// config is read at call time inside capacity.ts, so a module mock is enough.
vi.mock("../config.js", () => ({
  config: {
    AGENT_MAX_CONCURRENCY: 2,
    AGENT_SUBPROCESS_MB: 1024,
    AGENT_MEMORY_RESERVE_MB: 512,
    AGENT_ACQUIRE_TIMEOUT_MS: 1000,
  },
}));

const { acquireSlot, activeSubprocesses, AgentCapacityError } = await import("./capacity.js");

describe("acquireSlot", () => {
  beforeEach(async () => {
    // Drain anything a previous test left holding.
    while (activeSubprocesses() > 0) await new Promise((r) => setTimeout(r, 5));
  });

  it("never exceeds AGENT_MAX_CONCURRENCY under a burst", async () => {
    let peak = 0;
    const work = Array.from({ length: 8 }, async () => {
      const release = await acquireSlot("test");
      peak = Math.max(peak, activeSubprocesses());
      await new Promise((r) => setTimeout(r, 15));
      release();
    });
    await Promise.all(work);
    expect(peak).toBeLessThanOrEqual(2);
    expect(activeSubprocesses()).toBe(0);
  });

  it("hands a queued waiter the slot as soon as one frees", async () => {
    const a = await acquireSlot("a");
    const b = await acquireSlot("b");
    expect(activeSubprocesses()).toBe(2);

    let third = false;
    const pending = acquireSlot("c").then((release) => {
      third = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(third).toBe(false); // correctly blocked at the cap

    a();
    const releaseC = await pending;
    expect(third).toBe(true);
    b();
    releaseC();
    expect(activeSubprocesses()).toBe(0);
  });

  it("ignores a double release so the pool cannot drift upward", async () => {
    const release = await acquireSlot("dup");
    expect(activeSubprocesses()).toBe(1);
    release();
    release();
    release();
    expect(activeSubprocesses()).toBe(0);
  });

  it("throws AgentCapacityError rather than queueing forever", async () => {
    const held = [await acquireSlot("x"), await acquireSlot("y")];
    // AGENT_ACQUIRE_TIMEOUT_MS is 1000 in the mock above.
    await expect(acquireSlot("z")).rejects.toBeInstanceOf(AgentCapacityError);
    held.forEach((r) => r());
  });
});
