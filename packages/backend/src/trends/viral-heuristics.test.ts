import { describe, expect, it } from "vitest";
import { breakoutRatio, classifyOpener, computeViralHeuristics } from "./viral-heuristics.js";

describe("breakoutRatio", () => {
  it("is views over followers", () => {
    expect(breakoutRatio(500_000, 10_000)).toBe(50);
  });
  it("is 0 when followers unknown", () => {
    expect(breakoutRatio(500_000, 0)).toBe(0);
  });
});

describe("classifyOpener", () => {
  it("detects a question opener", () => {
    expect(classifyOpener("What if the algorithm isn't the problem?\n\nmore below")).toBe("question");
  });
  it("detects a number opener", () => {
    expect(classifyOpener("3 things nobody tells you about shipping AI")).toBe("number");
  });
  it("detects a $ number opener", () => {
    expect(classifyOpener("$0 to $10k MRR in 60 days. Here's how.")).toBe("number");
  });
  it("detects a bold claim opener", () => {
    expect(classifyOpener("Cursor is dead. Long live Claude Code.")).toBe("bold_claim");
  });
  it("treats hedged openers as plain", () => {
    expect(classifyOpener("i think maybe this could possibly work sometimes")).toBe("plain");
  });
});

describe("computeViralHeuristics", () => {
  const base = {
    viewCount: 1_000_000,
    likeCount: 8_000,
    retweetCount: 1_200,
    replyCount: 400,
    quoteCount: 300,
    bookmarkCount: 5_000,
    authorFollowers: 20_000,
    postedAtMs: Date.parse("2026-07-13T00:00:00Z"),
    nowMs: Date.parse("2026-07-13T10:00:00Z"),
    hasMedia: true,
    text: "A".repeat(200),
  };

  it("computes breakout ratio (50x escaped reach)", () => {
    expect(computeViralHeuristics(base).breakout_ratio).toBe(50);
  });

  it("computes engagement rates per 1k views", () => {
    const h = computeViralHeuristics(base);
    expect(h.like_rate_per_1k).toBe(8); // 8000 / 1_000_000 * 1000
    expect(h.bookmark_rate_per_1k).toBe(5);
  });

  it("computes velocity over elapsed hours", () => {
    const h = computeViralHeuristics(base);
    expect(h.hours_since_post).toBe(10);
    expect(h.views_per_hour).toBe(100_000);
  });

  it("computes amplification share (rt+quote vs likes)", () => {
    // (1200 + 300) / (1500 + 8000) = 1500/9500 ≈ 0.16
    expect(computeViralHeuristics(base).amplification_share).toBeCloseTo(0.16, 2);
  });

  it("buckets length and detects media", () => {
    const h = computeViralHeuristics(base);
    expect(h.length_bucket).toBe("medium");
    expect(h.has_media).toBe(true);
  });

  it("never divides by zero on a brand-new tweet with no followers", () => {
    const h = computeViralHeuristics({ ...base, authorFollowers: 0, nowMs: base.postedAtMs });
    expect(Number.isFinite(h.views_per_hour)).toBe(true);
    expect(h.breakout_ratio).toBe(0);
  });
});
