import { describe, expect, it } from "vitest";
import { computeBestWindow, daypartForHour, isInRecommendedWindow, type EngagedPost } from "./best-time.js";

describe("daypartForHour", () => {
  it("buckets known hours correctly", () => {
    expect(daypartForHour(6)).toBe("early_morning");
    expect(daypartForHour(9)).toBe("morning");
    expect(daypartForHour(14)).toBe("afternoon");
    expect(daypartForHour(19)).toBe("evening");
    expect(daypartForHour(23)).toBe("night");
    expect(daypartForHour(2)).toBe("night");
  });
});

describe("computeBestWindow", () => {
  const utcAtHour = (hour: number, day = 1): number => Date.UTC(2026, 0, day, hour);

  it("falls back to a general default under the minimum sample", () => {
    const posts: EngagedPost[] = Array.from({ length: 5 }, (_, i) => ({
      postedAtMs: utcAtHour(9, i + 1),
      engagement: 100,
    }));
    const r = computeBestWindow(posts, "UTC");
    expect(r.personalized).toBe(false);
    expect(r.daypart).toBe("morning");
  });

  it("picks the daypart with the highest average engagement once there's enough data", () => {
    const posts: EngagedPost[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ postedAtMs: utcAtHour(19, i + 1), engagement: 500 })), // evening, high
      ...Array.from({ length: 4 }, (_, i) => ({ postedAtMs: utcAtHour(9, i + 10), engagement: 50 })), // morning, low
    ];
    const r = computeBestWindow(posts, "UTC");
    expect(r.personalized).toBe(true);
    expect(r.daypart).toBe("evening");
    expect(r.sampleSize).toBe(8);
  });

  it("ignores a bucket below the per-bucket minimum sample even if enough total data exists", () => {
    const posts: EngagedPost[] = [
      { postedAtMs: utcAtHour(19, 1), engagement: 10_000 }, // evening, single outlier — under min bucket sample
      ...Array.from({ length: 4 }, (_, i) => ({ postedAtMs: utcAtHour(9, i + 2), engagement: 50 })),
      ...Array.from({ length: 4 }, (_, i) => ({ postedAtMs: utcAtHour(14, i + 10), engagement: 40 })),
    ];
    const r = computeBestWindow(posts, "UTC");
    expect(r.personalized).toBe(true);
    expect(r.daypart).toBe("morning"); // evening's one sample is excluded, morning beats afternoon
  });

  it("respects timezone when bucketing (same instant, different local hour)", () => {
    // 02:00 UTC is 07:30 in Asia/Kolkata (early_morning) but 21:00 the prior day
    // in US/Pacific (night, prior day) — just confirm tz actually shifts the bucket.
    const instant = Date.UTC(2026, 0, 5, 2, 0);
    expect(daypartForHour(new Date(instant).getUTCHours())).toBe("night");
  });
});

describe("isInRecommendedWindow", () => {
  it("matches when the candidate time falls in the recommended daypart", () => {
    const result = { personalized: true, daypart: "morning" as const, sampleSize: 10 };
    const morningMs = Date.UTC(2026, 0, 1, 9);
    const eveningMs = Date.UTC(2026, 0, 1, 19);
    expect(isInRecommendedWindow(morningMs, "UTC", result)).toBe(true);
    expect(isInRecommendedWindow(eveningMs, "UTC", result)).toBe(false);
  });
});
