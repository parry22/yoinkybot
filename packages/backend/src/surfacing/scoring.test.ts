import { describe, expect, it } from "vitest";
import { explainScore, novelty, pickBest, reactionBoost, score, type ScorableMemory } from "./scoring.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

function mem(overrides: Partial<ScorableMemory> = {}): ScorableMemory {
  return {
    id: "m1",
    createdAt: NOW - 10 * DAY,
    lastSurfacedAt: null,
    surfaceCount: 0,
    linkCount: 0,
    reactionNet: 0,
    ...overrides,
  };
}

describe("scoring", () => {
  it("never-surfaced memories are fully novel", () => {
    expect(novelty(mem(), NOW)).toBe(1);
  });

  it("a just-surfaced memory scores near zero novelty", () => {
    expect(novelty(mem({ lastSurfacedAt: NOW - 1000 }), NOW)).toBeLessThan(0.01);
  });

  it("more links beats fewer links, all else equal", () => {
    expect(score(mem({ linkCount: 5 }), NOW)).toBeGreaterThan(score(mem({ linkCount: 0 }), NOW));
  });

  it("prior surfacing count divides the score", () => {
    const fresh = score(mem(), NOW);
    const worn = score(mem({ surfaceCount: 3 }), NOW);
    expect(worn).toBeCloseTo(fresh / 4, 5);
  });

  it("old memories keep a recency floor and can win via links", () => {
    const oldLinked = mem({ id: "old", createdAt: NOW - 400 * DAY, linkCount: 8 });
    const newLonely = mem({ id: "new", createdAt: NOW - 1 * DAY, linkCount: 0 });
    expect(pickBest([oldLinked, newLonely], NOW)?.id).toBe("old");
  });

  it("💤 reactions suppress, 🔥 reactions boost, both clamped", () => {
    expect(reactionBoost(mem({ reactionNet: -10 }))).toBe(0.4);
    expect(reactionBoost(mem({ reactionNet: 10 }))).toBe(1.5);
    expect(reactionBoost(mem({ reactionNet: 1 }))).toBe(1.25);
  });

  it("pickBest returns undefined on empty input", () => {
    expect(pickBest([], NOW)).toBeUndefined();
  });

  it("explainScore mentions the load-bearing factors", () => {
    const reason = explainScore(mem({ linkCount: 3 }), NOW);
    expect(reason).toContain("never resurfaced");
    expect(reason).toContain("3 other thoughts");
  });
});
