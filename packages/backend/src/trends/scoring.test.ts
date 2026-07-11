import { describe, expect, it } from "vitest";
import { buzzScore, distinctAuthorCount, totalEngagement, velocity, type BuzzTweet } from "./scoring.js";

const tweet = (over: Partial<BuzzTweet>): BuzzTweet => ({
  authorHandle: "a",
  likeCount: 0,
  retweetCount: 0,
  replyCount: 0,
  createdAtMs: 0,
  ...over,
});

describe("distinctAuthorCount", () => {
  it("dedupes by author, case-insensitively — one loud account is not a trend", () => {
    const tweets = [tweet({ authorHandle: "Sam" }), tweet({ authorHandle: "sam" }), tweet({ authorHandle: "ana" })];
    expect(distinctAuthorCount(tweets)).toBe(2);
  });
  it("ignores tweets with no resolvable author", () => {
    expect(distinctAuthorCount([tweet({ authorHandle: "" })])).toBe(0);
  });
});

describe("totalEngagement", () => {
  it("sums likes + retweets + replies, clamping negatives", () => {
    const tweets = [tweet({ likeCount: 10, retweetCount: 5, replyCount: 2 }), tweet({ likeCount: -3 })];
    expect(totalEngagement(tweets)).toBe(17);
  });
});

describe("velocity", () => {
  it("reads acceleration as 2nd-half over 1st-half count", () => {
    const tweets = [tweet({ createdAtMs: 10 }), tweet({ createdAtMs: 60 }), tweet({ createdAtMs: 90 })];
    expect(velocity(tweets, 0, 100)).toBe(2); // 1 early, 2 late
  });
  it("treats a cold-start burst as max acceleration and a dead window as 0", () => {
    expect(velocity([tweet({ createdAtMs: 80 })], 0, 100)).toBe(2);
    expect(velocity([], 0, 100)).toBe(0);
  });
  it("excludes tweets outside the window", () => {
    expect(velocity([tweet({ createdAtMs: 500 })], 0, 100)).toBe(0);
  });
});

describe("buzzScore", () => {
  it("is 0 for a dead topic and grows monotonically with each signal", () => {
    expect(buzzScore({ distinctAuthors: 0, totalEngagement: 0, velocity: 0, inTrendList: false })).toBe(0);
    const base = buzzScore({ distinctAuthors: 50, totalEngagement: 5000, velocity: 1, inTrendList: false });
    const ranked = buzzScore({ distinctAuthors: 50, totalEngagement: 5000, velocity: 1, inTrendList: true });
    expect(ranked).toBeGreaterThan(base);
    expect(ranked).toBeLessThanOrEqual(1);
  });
  it("saturates instead of letting one huge component dominate", () => {
    const max = buzzScore({ distinctAuthors: 1e6, totalEngagement: 1e9, velocity: 50, inTrendList: true });
    expect(max).toBe(1);
  });
});
