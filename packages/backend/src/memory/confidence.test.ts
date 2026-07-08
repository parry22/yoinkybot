import { describe, it, expect } from "vitest";
import { effectiveConfidence, decideReconciliation, STALE_CONFIDENCE } from "./confidence.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("effectiveConfidence", () => {
  it("a just-affirmed one-off statement sits at the base", () => {
    expect(effectiveConfidence(1, NOW, NOW)).toBeCloseTo(0.67, 2);
  });

  it("reinforcement raises confidence, capped", () => {
    expect(effectiveConfidence(3, NOW, NOW)).toBeCloseTo(0.81, 2);
    expect(effectiveConfidence(5, NOW, NOW)).toBeCloseTo(0.95, 2);
    expect(effectiveConfidence(50, NOW, NOW)).toBeCloseTo(0.95, 2); // cap
  });

  it("halves every 90 days since last affirmation", () => {
    const fresh = effectiveConfidence(1, NOW, NOW);
    expect(effectiveConfidence(1, NOW - 90 * DAY, NOW)).toBeCloseTo(fresh / 2, 3);
    expect(effectiveConfidence(1, NOW - 180 * DAY, NOW)).toBeCloseTo(fresh / 4, 3);
  });

  it("a strongly reinforced belief outlasts a one-off after the same decay", () => {
    const oneOff = effectiveConfidence(1, NOW - 120 * DAY, NOW);
    const held = effectiveConfidence(5, NOW - 120 * DAY, NOW);
    expect(held).toBeGreaterThan(oneOff);
  });

  it("never decays below the floor, and one-offs eventually go stale", () => {
    expect(effectiveConfidence(1, NOW - 3650 * DAY, NOW)).toBe(0.05);
    expect(effectiveConfidence(1, NOW - 240 * DAY, NOW)).toBeLessThan(STALE_CONFIDENCE);
  });

  it("treats reinforcement below 1 as 1 (defensive)", () => {
    expect(effectiveConfidence(0, NOW, NOW)).toBe(effectiveConfidence(1, NOW, NOW));
  });
});

describe("decideReconciliation", () => {
  it("no judgments → plain insert", () => {
    expect(decideReconciliation([])).toEqual({ reinforceId: undefined, supersedeIds: [], insert: true });
  });

  it("all unrelated → plain insert", () => {
    expect(decideReconciliation([{ id: "a", relation: "unrelated" }])).toEqual({
      reinforceId: undefined,
      supersedeIds: [],
      insert: true,
    });
  });

  it("same → reinforce, no insert", () => {
    expect(decideReconciliation([{ id: "a", relation: "same" }])).toEqual({
      reinforceId: "a",
      supersedeIds: [],
      insert: false,
    });
  });

  it("contradicts → insert new and supersede the old", () => {
    expect(
      decideReconciliation([
        { id: "a", relation: "contradicts" },
        { id: "b", relation: "unrelated" },
      ]),
    ).toEqual({ reinforceId: undefined, supersedeIds: ["a"], insert: true });
  });

  it("same + contradicts → the re-affirmed belief displaces the contradicted one", () => {
    expect(
      decideReconciliation([
        { id: "a", relation: "same" },
        { id: "b", relation: "contradicts" },
      ]),
    ).toEqual({ reinforceId: "a", supersedeIds: ["b"], insert: false });
  });

  it("never supersedes the position it reinforces", () => {
    const d = decideReconciliation([
      { id: "a", relation: "same" },
      { id: "a", relation: "contradicts" },
    ]);
    expect(d.reinforceId).toBe("a");
    expect(d.supersedeIds).toEqual([]);
  });

  it("multiple contradictions are all superseded", () => {
    const d = decideReconciliation([
      { id: "a", relation: "contradicts" },
      { id: "b", relation: "contradicts" },
    ]);
    expect(d.supersedeIds).toEqual(["a", "b"]);
    expect(d.insert).toBe(true);
  });
});
