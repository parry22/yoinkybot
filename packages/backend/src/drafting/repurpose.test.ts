import { describe, expect, it } from "vitest";
import { parseRepurposeCommand, lengthStats, cosineDistance, fidelityOk } from "./repurpose.js";

describe("parseRepurposeCommand", () => {
  it("cross-platform forms", () => {
    expect(parseRepurposeCommand("linkedin My post about distribution")).toEqual({
      mode: "cross_platform",
      target: "linkedin",
      text: "My post about distribution",
    });
    expect(parseRepurposeCommand("x Some LinkedIn essay text")).toEqual({
      mode: "cross_platform",
      target: "x",
      text: "Some LinkedIn essay text",
    });
    expect(parseRepurposeCommand("twitter same thing")!.target).toBe("x");
  });

  it("cross-format forms carry direction", () => {
    expect(parseRepurposeCommand("compress 1/ first 2/ second 3/ third")).toMatchObject({
      mode: "cross_format",
      direction: "compress",
    });
    expect(parseRepurposeCommand("expand A dense post")).toMatchObject({ mode: "cross_format", direction: "expand" });
  });

  it("synthesis defaults to long-form on LinkedIn", () => {
    expect(parseRepurposeCommand("synthesis creator burnout as systems failure")).toEqual({
      mode: "synthesis",
      target: "linkedin",
      text: "creator burnout as systems failure",
    });
  });

  it("rejects empty content and unknown forms", () => {
    expect(parseRepurposeCommand("")).toBeNull();
    expect(parseRepurposeCommand("linkedin")).toBeNull();
    expect(parseRepurposeCommand("instagram my post")).toBeNull();
  });

  it("preserves multiline pasted content", () => {
    const parsed = parseRepurposeCommand("compress line one\nline two\nline three");
    expect(parsed!.text).toBe("line one\nline two\nline three");
  });
});

describe("lengthStats", () => {
  it("needs at least 3 samples", () => {
    expect(lengthStats([100, 200])).toBeNull();
  });
  it("computes median and quartiles from real lengths", () => {
    const s = lengthStats([100, 200, 300, 400, 500, 600, 700, 800])!;
    expect(s.median).toBe(500);
    expect(s.p25).toBe(300);
    expect(s.p75).toBe(700);
  });
});

describe("cosineDistance + fidelityOk", () => {
  it("identical vectors are distance 0, orthogonal are 1", () => {
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0, 6);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 6);
  });
  it("zero vectors are maximally distant, not NaN", () => {
    expect(cosineDistance([0, 0], [1, 0])).toBe(1);
  });
  it("fidelity gate sits at 0.4", () => {
    expect(fidelityOk(0.39)).toBe(true);
    expect(fidelityOk(0.41)).toBe(false);
  });
});
