import { describe, expect, it } from "vitest";
import { analyzePosts, median, renderPerformance, type PerfPost, type PerformanceData } from "./performance.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const PERIOD_START = NOW - 14 * DAY;

function post(o: Partial<PerfPost>): PerfPost {
  return {
    platform: "x",
    engagement: 10,
    capturedAt: NOW - DAY,
    alignedDistance: 0.3,
    orientation: "outside_in",
    content: "a post",
    url: "https://x.com/u/status/1",
    unlockIdea: null,
    ...o,
  };
}

/** 10 baseline posts (older than the period), median engagement 10. */
function baseline(engagements = [8, 9, 10, 10, 10, 10, 10, 11, 12, 10]): PerfPost[] {
  return engagements.map((e, i) => post({ engagement: e, capturedAt: PERIOD_START - (i + 1) * DAY }));
}

describe("median", () => {
  it("handles empty, odd, even", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("analyzePosts", () => {
  it("splits baseline from period and computes medians", () => {
    const posts = [...baseline(), post({ engagement: 20 }), post({ engagement: 30 })];
    const a = analyzePosts(posts, PERIOD_START, NOW);
    expect(a.baseline.posts).toBe(10);
    expect(a.baseline.median).toBe(10);
    expect(a.period.posts).toBe(2);
    expect(a.period.median).toBe(25);
    expect(a.periodDays).toBe(14);
  });

  it("posts without engagement count toward cadence but not rates", () => {
    const posts = [...baseline(), post({ engagement: null }), post({ engagement: 12 })];
    const a = analyzePosts(posts, PERIOD_START, NOW);
    expect(a.period.posts).toBe(2);
    expect(a.period.withEngagement).toBe(1);
    expect(a.period.median).toBe(12);
  });

  it("throughline split requires 2+ engagement-bearing posts per bucket", () => {
    const thin = [...baseline(), post({ alignedDistance: 0.2 }), post({ alignedDistance: 0.8 })];
    expect(analyzePosts(thin, PERIOD_START, NOW).split).toBeNull();

    const enough = [
      ...baseline(),
      post({ alignedDistance: 0.2, engagement: 20 }),
      post({ alignedDistance: 0.3, engagement: 24 }),
      post({ alignedDistance: 0.8, engagement: 6 }),
      post({ alignedDistance: 0.9, engagement: 8 }),
    ];
    const a = analyzePosts(enough, PERIOD_START, NOW);
    expect(a.split).toEqual({ aligned: { posts: 2, median: 22 }, off: { posts: 2, median: 7 } });
  });

  it("flags outliers at 1.5x the baseline median, with mechanism evidence attached", () => {
    const posts = [
      ...baseline(),
      post({ engagement: 14 }), // 1.4x — not an outlier
      post({ engagement: 15, content: "the burnout essay", orientation: "outside_in", alignedDistance: 0.2, unlockIdea: "burnout as systems failure" }),
      post({ engagement: 40, content: "big one", alignedDistance: 0.9 }),
    ];
    const a = analyzePosts(posts, PERIOD_START, NOW);
    expect(a.outliers).toHaveLength(2);
    expect(a.outliers[0]).toMatchObject({ engagement: 40, ratio: 4, aligned: false });
    expect(a.outliers[1]).toMatchObject({
      engagement: 15,
      ratio: 1.5,
      orientation: "outside_in",
      aligned: true,
      unlockIdea: "burnout as systems failure",
    });
  });

  it("refuses outliers on a thin baseline — 1.5x of noise is not a finding", () => {
    const posts = [post({ engagement: 5, capturedAt: PERIOD_START - DAY }), post({ engagement: 100 })];
    expect(analyzePosts(posts, PERIOD_START, NOW).outliers).toHaveLength(0);
  });

  it("computes actual cadence per week from all period posts", () => {
    const posts = [...baseline(), post({}), post({}), post({ engagement: null }), post({})];
    expect(analyzePosts(posts, PERIOD_START, NOW).actualPerWeek).toBe(2);
  });
});

describe("renderPerformance", () => {
  function data(over: Partial<PerformanceData> = {}): PerformanceData {
    return {
      analysis: analyzePosts([...baseline(), post({ engagement: 12 }), post({ engagement: 14 })], PERIOD_START, NOW),
      xConfidence: "full",
      xConfidenceReason: "",
      linkedinConnected: true,
      unlock: { developedInPeriod: 1, developedTotal: 2, pending: 3 },
      committedPerWeek: 2,
      draftsInPeriod: 4,
      ...over,
    };
  }

  it("carries every measured number verbatim", () => {
    const text = renderPerformance(data());
    expect(text).toContain("baseline median engagement 10 per post (measured over 10 prior posts)");
    expect(text).toContain("this period 2 posts");
    expect(text).toContain("median 13");
    expect(text).toContain("130% of baseline");
    expect(text).toContain("1 developed this period · 2 developed total · 3 still pending");
    expect(text).toContain("committed 2/week · actual 1/week");
    expect(text).toContain("LinkedIn: engagement metrics are not available");
  });

  it("states unavailable data plainly instead of numbers", () => {
    const text = renderPerformance(data({ xConfidence: "unavailable", xConfidenceReason: "no posts carry engagement metrics" }));
    expect(text).toContain("X engagement: unavailable this period");
    expect(text).not.toContain("baseline median engagement");
  });

  it("names a too-thin split rather than inventing one", () => {
    const text = renderPerformance(data());
    expect(text).toContain("too few posts this period to split meaningfully");
  });
});
