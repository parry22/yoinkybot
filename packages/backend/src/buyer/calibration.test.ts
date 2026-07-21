import { describe, expect, it } from "vitest";
import { buildCalibration, type BuyerThresholds } from "./calibration.js";

const base: BuyerThresholds = { intent: 0.45, niche: 0.55 };
const counts = (over: Partial<{ not_a_fit: number; skipped: number; replied: number }> = {}) => ({
  not_a_fit: 0,
  skipped: 0,
  replied: 0,
  ...over,
});

describe("buildCalibration", () => {
  it("no feedback → unchanged defaults", () => {
    expect(buildCalibration(counts(), base)).toEqual(base);
  });

  it("not_a_fit tightens the niche gate (lower threshold)", () => {
    const t = buildCalibration(counts({ not_a_fit: 3 }), base);
    expect(t.niche).toBeLessThan(base.niche);
  });

  it("replies relax the niche gate back toward base", () => {
    const tightened = buildCalibration(counts({ not_a_fit: 3 }), base).niche;
    const relaxed = buildCalibration(counts({ not_a_fit: 3, replied: 3 }), base).niche;
    expect(relaxed).toBeGreaterThanOrEqual(tightened);
    expect(relaxed).toBe(base.niche);
  });

  it("skips raise the intent bar; replies lower it", () => {
    expect(buildCalibration(counts({ skipped: 3 }), base).intent).toBeGreaterThan(base.intent);
    expect(buildCalibration(counts({ replied: 3 }), base).intent).toBeLessThan(base.intent);
  });

  it("clamps the niche tightening to a floor", () => {
    const t = buildCalibration(counts({ not_a_fit: 50 }), base);
    expect(t.niche).toBeGreaterThanOrEqual(base.niche - 0.15 - 1e-9);
    expect(t.niche).toBeGreaterThanOrEqual(0.35);
  });

  it("clamps the intent bar within bounds in both directions", () => {
    const up = buildCalibration(counts({ skipped: 50, not_a_fit: 50 }), base).intent;
    const down = buildCalibration(counts({ replied: 50 }), base).intent;
    expect(up).toBeLessThanOrEqual(0.75);
    expect(up).toBeLessThanOrEqual(base.intent + 0.15 + 1e-9);
    expect(down).toBeGreaterThanOrEqual(0.3);
    expect(down).toBeGreaterThanOrEqual(base.intent - 0.1 - 1e-9);
  });
});
