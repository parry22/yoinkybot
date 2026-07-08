import { describe, expect, it } from "vitest";
import {
  reachScore,
  relationshipStrength,
  replyWorthyScore,
  learnedThreshold,
  pickNextMention,
  BASE_THRESHOLD,
  type ReplyOutcome,
} from "./scoring.js";

describe("reachScore", () => {
  it("log-scales followers into 0..1", () => {
    expect(reachScore(0)).toBe(0);
    expect(reachScore(999_999)).toBeCloseTo(1, 2);
    expect(reachScore(50_000_000)).toBe(1); // saturates
    expect(reachScore(1000)).toBeCloseTo(0.5, 1);
  });
});

describe("relationshipStrength", () => {
  it("is 0 for strangers and weighs sent replies over prior mentions", () => {
    expect(relationshipStrength(0, 0)).toBe(0);
    expect(relationshipStrength(2, 0)).toBeCloseTo(0.3, 5);
    expect(relationshipStrength(0, 1)).toBeCloseTo(0.4, 5);
    expect(relationshipStrength(10, 10)).toBe(1); // capped
  });
});

describe("replyWorthyScore", () => {
  it("applies the spec weights", () => {
    expect(replyWorthyScore({ reach01: 1, isQuestion: true, isSubstantiveChallenge: true, relationship: 1 })).toBe(1);
    expect(replyWorthyScore({ reach01: 0, isQuestion: true, isSubstantiveChallenge: false, relationship: 0 })).toBe(0.3);
    expect(replyWorthyScore({ reach01: 0, isQuestion: false, isSubstantiveChallenge: true, relationship: 0 })).toBe(0.25);
    expect(replyWorthyScore({ reach01: 0.5, isQuestion: false, isSubstantiveChallenge: false, relationship: 0.4 })).toBeCloseTo(0.21, 3);
  });

  it("a low-reach '🔥 so true' style mention never clears the base bar", () => {
    const noise = replyWorthyScore({ reach01: reachScore(300), isQuestion: false, isSubstantiveChallenge: false, relationship: 0 });
    expect(noise).toBeLessThan(BASE_THRESHOLD);
  });
});

describe("learnedThreshold", () => {
  const o = (score: number, status: "sent" | "skipped"): ReplyOutcome => ({ score, status });

  it("stays at base with too little feedback", () => {
    expect(learnedThreshold([])).toBe(BASE_THRESHOLD);
    expect(learnedThreshold([o(0.5, "skipped"), o(0.5, "skipped")])).toBe(BASE_THRESHOLD);
  });

  it("rises above what a skip-heavy user keeps skipping", () => {
    const outcomes = [o(0.5, "skipped"), o(0.52, "skipped"), o(0.48, "skipped"), o(0.55, "skipped"), o(0.6, "sent")];
    const t = learnedThreshold(outcomes);
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThanOrEqual(0.85);
  });

  it("relaxes slightly for a send-heavy user", () => {
    const outcomes = [o(0.5, "sent"), o(0.6, "sent"), o(0.55, "sent"), o(0.7, "sent"), o(0.5, "skipped")];
    expect(learnedThreshold(outcomes)).toBeCloseTo(BASE_THRESHOLD - 0.05, 5);
  });

  it("mixed feedback holds the base", () => {
    const outcomes = [o(0.5, "sent"), o(0.6, "skipped"), o(0.55, "sent"), o(0.7, "skipped"), o(0.5, "skipped")];
    expect(learnedThreshold(outcomes)).toBe(BASE_THRESHOLD);
  });
});

describe("pickNextMention", () => {
  const m = (id: string, challenge: boolean, question: boolean, score: number) => ({
    id,
    isSubstantiveChallenge: challenge,
    isQuestion: question,
    score,
  });

  it("substantive challenge beats a higher-scoring question", () => {
    expect(pickNextMention([m("q", false, true, 0.9), m("c", true, false, 0.6)])!.id).toBe("c");
  });

  it("question beats a higher-scoring plain mention", () => {
    expect(pickNextMention([m("plain", false, false, 0.95), m("q", false, true, 0.5)])!.id).toBe("q");
  });

  it("ties break on score; empty gives null", () => {
    expect(pickNextMention([m("a", false, true, 0.5), m("b", false, true, 0.8)])!.id).toBe("b");
    expect(pickNextMention([])).toBeNull();
  });
});
