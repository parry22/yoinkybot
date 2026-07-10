import { describe, expect, it } from "vitest";
import { decideColdStart, pickNudge, COLD_START_MIN_HOURS, type NudgeInputs } from "./nudges.js";

const HOUR = 60 * 60 * 1000;

describe("decideColdStart", () => {
  const confirmed = 1_750_000_000_000;
  it("fires after the silence window with zero proactive contact", () => {
    expect(
      decideColdStart({
        planConfirmedAt: confirmed,
        proactiveSinceConfirm: 0,
        now: confirmed + (COLD_START_MIN_HOURS + 1) * HOUR,
      }),
    ).toBe(true);
  });
  it("does not fire before the window", () => {
    expect(
      decideColdStart({ planConfirmedAt: confirmed, proactiveSinceConfirm: 0, now: confirmed + 2 * HOUR }),
    ).toBe(false);
  });
  it("does not fire once anything proactive has been delivered", () => {
    expect(
      decideColdStart({
        planConfirmedAt: confirmed,
        proactiveSinceConfirm: 1,
        now: confirmed + 100 * HOUR,
      }),
    ).toBe(false);
  });
  it("does not fire without an active plan", () => {
    expect(decideColdStart({ planConfirmedAt: null, proactiveSinceConfirm: 0, now: confirmed })).toBe(false);
  });
});

const base = (o: Partial<NudgeInputs> = {}): NudgeInputs => ({
  memoryCount: 10,
  hasVoiceProfile: false,
  stage: "plan_active",
  diagnosisAgeDays: 30,
  hasGoals: true,
  planActive: true,
  planAgeDays: 30,
  cadencePerWeek: 3,
  draftsLast14d: 2,
  daysSinceProgressReport: 3,
  recentNudgeKinds: [],
  ...o,
});

describe("pickNudge", () => {
  it("offers the voice profile once the threshold is crossed without one", () => {
    expect(pickNudge(base({ memoryCount: 60 }))).toBe("voice");
  });
  it("stays quiet below the voice threshold", () => {
    expect(pickNudge(base({ memoryCount: 49 }))).toBeNull();
  });
  it("does not re-offer voice inside the dedup window", () => {
    expect(pickNudge(base({ memoryCount: 60, recentNudgeKinds: ["voice"] }))).toBeNull();
  });
  it("nudges a stalled diagnosis→goals hop after 3 days", () => {
    expect(pickNudge(base({ stage: "diagnosed", hasGoals: false, diagnosisAgeDays: 4 }))).toBe("goals_stall");
    expect(pickNudge(base({ stage: "diagnosed", hasGoals: false, diagnosisAgeDays: 1 }))).toBeNull();
  });
  it("nudges a shipping stall only when the progress report isn't imminent", () => {
    const stalled = base({ draftsLast14d: 0, daysSinceProgressReport: 8 });
    expect(pickNudge(stalled)).toBe("shipping_stall");
    expect(pickNudge(base({ draftsLast14d: 0, daysSinceProgressReport: 2 }))).toBeNull();
  });
  it("does not shame a fresh plan for not shipping yet", () => {
    expect(pickNudge(base({ draftsLast14d: 0, daysSinceProgressReport: 20, planAgeDays: 5 }))).toBeNull();
  });
  it("voice outranks other nudges", () => {
    expect(pickNudge(base({ memoryCount: 60, stage: "diagnosed", hasGoals: false }))).toBe("voice");
  });
  it("returns null when everything is healthy", () => {
    expect(pickNudge(base())).toBeNull();
  });
});
