import { describe, expect, it } from "vitest";
import { isSincereEnough, detectStructuralMarker, SINCERITY_VALUES, MOTIVE_VALUES } from "./classification.js";

describe("isSincereEnough", () => {
  it("treats a confident sincere call as sincere", () => {
    expect(isSincereEnough("sincere", 0.8)).toBe(true);
  });
  it("fails a low-confidence sincere call closed", () => {
    expect(isSincereEnough("sincere", 0.3)).toBe(false);
  });
  it("fails ironic/self_deprecating/absurdist/ambiguous regardless of confidence", () => {
    for (const r of ["ironic", "self_deprecating", "absurdist", "ambiguous"]) {
      expect(isSincereEnough(r, 0.99)).toBe(false);
    }
  });
  it("treats NULL/undefined as sincere (backward compat for pre-feature data)", () => {
    expect(isSincereEnough(null, null)).toBe(true);
    expect(isSincereEnough(undefined, undefined)).toBe(true);
  });
  it("treats missing confidence as 0 (fails closed)", () => {
    expect(isSincereEnough("sincere", null)).toBe(false);
  });
});

describe("detectStructuralMarker", () => {
  it("detects day-numbered series", () => {
    expect(detectStructuralMarker("Day 14 of building my SaaS")).toBe("day-series");
    expect(detectStructuralMarker("day #3 of shipping daily")).toBe("day-series");
  });
  it("detects week-numbered series", () => {
    expect(detectStructuralMarker("Week 6 update on the product")).toBe("week-series");
  });
  it("detects generic numbered series markers", () => {
    expect(detectStructuralMarker("Part 3 of my founder journey")).toBe("numbered-series");
    expect(detectStructuralMarker("Update #7: still grinding")).toBe("numbered-series");
  });
  it("detects a bracketed running tag", () => {
    expect(detectStructuralMarker("[buildinpublic] shipped the auth flow today")).toBe("tag:buildinpublic");
  });
  it("detects a series-shaped hashtag", () => {
    expect(detectStructuralMarker("grinding away #100DaysOfCode")).toBe("tag:100daysofcode");
  });
  it("returns null for an ordinary post", () => {
    expect(detectStructuralMarker("Distribution beats product every time.")).toBeNull();
  });
});

describe("taxonomy", () => {
  it("has the 5 sincerity values and 7 motive values from the spec", () => {
    expect(SINCERITY_VALUES).toHaveLength(5);
    expect(MOTIVE_VALUES).toHaveLength(7);
  });
});
