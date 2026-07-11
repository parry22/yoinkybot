import { describe, expect, it } from "vitest";
import {
  computeHeuristics,
  minutesSincePost,
  opReplyEngagementRate,
  EARLY_WINDOW_MINUTES,
} from "./heuristics.js";

describe("minutesSincePost", () => {
  it("rounds to minutes and never goes negative", () => {
    expect(minutesSincePost(0, 90_000)).toBe(2);
    expect(minutesSincePost(100_000, 0)).toBe(0); // clock skew → 0, not negative
  });
});

describe("opReplyEngagementRate", () => {
  it("is the reply share of total engagement", () => {
    expect(opReplyEngagementRate(10, 80, 10)).toBeCloseTo(0.1, 3);
    expect(opReplyEngagementRate(50, 50, 0)).toBeCloseTo(0.5, 3);
  });
  it("is 0 with no engagement at all", () => {
    expect(opReplyEngagementRate(0, 0, 0)).toBe(0);
  });
});

describe("computeHeuristics", () => {
  const base = { postedAtMs: 0, replyCount: 4, likeCount: 12, retweetCount: 4 };

  it("flags the early window on both sides of the boundary", () => {
    const early = computeHeuristics({ ...base, nowMs: (EARLY_WINDOW_MINUTES - 1) * 60_000 });
    expect(early.is_early_window).toBe(true);
    const late = computeHeuristics({ ...base, nowMs: EARLY_WINDOW_MINUTES * 60_000 });
    expect(late.is_early_window).toBe(false);
  });

  it("carries thread depth through and clamps unknown counts at 0", () => {
    const h = computeHeuristics({ postedAtMs: 0, nowMs: 60_000, replyCount: -1, likeCount: 0, retweetCount: 0 });
    expect(h.thread_reply_count).toBe(0);
    expect(computeHeuristics({ ...base, nowMs: 60_000 }).thread_reply_count).toBe(4);
  });
});
