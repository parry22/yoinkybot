import { describe, it, expect } from "vitest";
import { computeVoiceStats, formatVoiceStats } from "./voice-stats.js";
import { summarizeClusters } from "../strategist/evidence.js";

const post = (content: string, date: string) => ({ content, created_at: date });

describe("computeVoiceStats", () => {
  it("returns null under 5 posts", () => {
    expect(computeVoiceStats([post("Too little here to measure.", "2026-01-01")])).toBeNull();
  });

  it("measures sentence lengths and punctuation habits", () => {
    const posts = [
      post("Ship it now! Distribution wins every time.", "2026-01-01"),
      post("most founders overrate polish; storytelling is the real moat", "2026-01-05"),
      post("Why does everyone ignore this? It baffles me.", "2026-02-01"),
      post("Short one.", "2026-02-10"),
      post("The teams that win in crowded markets built an audience long before they needed one at all.", "2026-03-01"),
    ];
    const v = computeVoiceStats(posts)!;
    expect(v.postCount).toBe(5);
    expect(v.meanSentenceLen).toBeGreaterThan(3);
    expect(v.perPost.exclamations).toBeCloseTo(0.2, 5);
    expect(v.perPost.semicolons).toBeCloseTo(0.2, 5);
    expect(v.perPost.questions).toBeCloseTo(0.2, 5);
    expect(v.lowercaseStartPct).toBeCloseTo(20, 5);
    expect(v.drift).toBeNull(); // under 12 posts
  });

  it("counts hedging phrases", () => {
    const posts = Array.from({ length: 5 }, (_, i) =>
      post(i < 2 ? "I think maybe this could work, perhaps." : "This works. Full stop.", `2026-01-0${i + 1}`),
    );
    const v = computeVoiceStats(posts)!;
    expect(v.hedgesPerPost).toBeGreaterThan(0.5);
  });

  it("measures early-vs-recent drift with 12+ dated posts", () => {
    const early = Array.from({ length: 6 }, (_, i) =>
      post("Ship fast! Break things! Momentum is everything and speed compounds daily!", `2025-0${i + 1}-01`),
    );
    const late = Array.from({ length: 6 }, (_, i) =>
      post("I think perhaps we should probably consider whether velocity is maybe overvalued in some contexts.", `2026-0${i + 1}-01`),
    );
    const v = computeVoiceStats([...early, ...late])!;
    expect(v.drift).not.toBeNull();
    expect(v.drift!.earlyExclaimPerPost).toBeGreaterThan(v.drift!.recentExclaimPerPost);
    expect(v.drift!.recentHedgesPerPost).toBeGreaterThan(v.drift!.earlyHedgesPerPost);
    expect(v.drift!.earlyPeriod.startsWith("2025")).toBe(true);
    expect(v.drift!.recentPeriod.startsWith("2026")).toBe(true);
  });

  it("formats without crashing and includes the ratio numbers", () => {
    const posts = Array.from({ length: 6 }, (_, i) => post("A steady sentence for measuring things.", `2026-01-0${i + 1}`));
    const text = formatVoiceStats(computeVoiceStats(posts)!);
    expect(text).toContain("6 posts measured");
    expect(text).toContain("em dashes");
  });
});

describe("summarizeClusters", () => {
  const item = (content: string, date: string, vector: number[]) => ({ content, created_at: date, vector });

  it("marks a theme recurring only with 3+ items across 2+ months", () => {
    const items = [
      item("distribution beats product", "2026-01-05", [0, 0]),
      item("distribution is the moat", "2026-02-10", [0, 0]),
      item("audience first, product second", "2026-03-15", [0, 0]),
      item("one-off tangent", "2026-01-20", [1, 1]),
    ];
    const assignments = [0, 0, 0, 1];
    const clusters = summarizeClusters(items, assignments, 2);
    expect(clusters[0]!.size).toBe(3);
    expect(clusters[0]!.recurring).toBe(true);
    expect(clusters[0]!.span).toBe("2026-01..2026-03");
    expect(clusters[1]!.recurring).toBe(false);
  });

  it("3 items inside one month is NOT recurring (one-off reaction burst)", () => {
    const items = [
      item("a", "2026-01-01", [0]),
      item("b", "2026-01-15", [0]),
      item("c", "2026-01-28", [0]),
    ];
    const clusters = summarizeClusters(items, [0, 0, 0], 1);
    expect(clusters[0]!.recurring).toBe(false);
    expect(clusters[0]!.monthSpread).toBe(1);
  });

  it("sorts largest theme first and dates samples", () => {
    const items = [
      item("small", "2026-01-01", [0]),
      item("big1", "2026-01-01", [1]),
      item("big2", "2026-02-01", [1]),
      item("big3", "2026-03-01", [1]),
    ];
    const clusters = summarizeClusters(items, [0, 1, 1, 1], 2);
    expect(clusters[0]!.size).toBe(3);
    expect(clusters[0]!.samples[0]).toMatch(/^\[2026-01-01\]/);
  });
});
