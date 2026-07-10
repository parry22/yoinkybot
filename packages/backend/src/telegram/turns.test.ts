import { describe, it, expect } from "vitest";
import { runSerializedTurn, hasActiveTurn } from "./turns.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("runSerializedTurn", () => {
  it("runs a single turn straight through", async () => {
    const seen: string[] = [];
    await runSerializedTurn("u1", "hello", null, async (t) => void seen.push(t));
    expect(seen).toEqual(["hello"]);
    expect(hasActiveTurn("u1")).toBe(false);
  });

  it("merges a burst that arrives mid-turn into one follow-up turn", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const first = runSerializedTurn("u2", "part one", null, async (t) => {
      seen.push(t);
      if (seen.length === 1) await gate; // hold the first turn open
    });
    await tick();
    // Two fragments land while the first turn is still running.
    void runSerializedTurn("u2", "part two", null, async (t) => void seen.push(t));
    void runSerializedTurn("u2", "part three", null, async (t) => void seen.push(t));
    await tick();
    release();
    await first;

    expect(seen).toEqual(["part one", "part two\npart three"]);
  });

  it("keeps users isolated from each other", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const a = runSerializedTurn("a", "slow", null, async (t) => {
      await gate;
      seen.push(`a:${t}`);
    });
    await tick();
    await runSerializedTurn("b", "fast", null, async (t) => void seen.push(`b:${t}`));
    release();
    await a;

    expect(seen).toEqual(["b:fast", "a:slow"]);
  });

  it("a throwing turn does not wedge the queue", async () => {
    const seen: string[] = [];
    await runSerializedTurn("u3", "boom", null, async () => {
      throw new Error("turn failed");
    });
    await runSerializedTurn("u3", "next", null, async (t) => void seen.push(t));
    expect(seen).toEqual(["next"]);
  });

  it("a queued turn that throws still releases the slot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runSerializedTurn("u4", "one", null, async () => {
      await gate;
    });
    await tick();
    void runSerializedTurn("u4", "two", null, async () => {
      throw new Error("second failed");
    });
    release();
    await first;
    expect(hasActiveTurn("u4")).toBe(false);
  });
});
