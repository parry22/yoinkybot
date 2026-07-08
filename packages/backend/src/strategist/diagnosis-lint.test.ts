import { describe, it, expect } from "vitest";
import { lintDiagnosis, violationInstruction } from "./diagnosis-lint.js";
import type { Diagnosis } from "./diagnosis.js";

function clean(): Diagnosis {
  return {
    headline: "You have said distribution beats product nine times since March 2026. Nobody following you knows it is your flag.",
    intellectual_fingerprint: {
      read: "Two beliefs recur constantly.",
      owned_positions: ['"Distribution beats product" stated 9 times, Mar 2026 to Jun 2026'],
      latent_beliefs: ["Solo founders plus AI is the real story"],
    },
    voice_signature: { read: "Short, declarative, no hashtags. Variation coefficient 0.71, alive.", drift: "" },
    outside_in_gap: { read: "31 of 40 classified posts are inside-out, 78%.", missed_swings: ["The May 2026 OpenAI pricing storm passed without a word from you"] },
    consistency_audit: [
      { tension: 'Oct 2025 "venture forces growth you don\'t want" vs Apr 2026 "raising because venture speed wins"', why_interesting: "Your relationship to speed changed when it was your round." },
    ],
    unsaid_patterns: [{ idea: "Creator burnout as a systems failure", evidence: "Three replies circling it: Jan 12, Feb 3, Apr 20 of 2026" }],
  };
}

describe("lintDiagnosis", () => {
  it("passes a compliant diagnosis", () => {
    expect(lintDiagnosis(clean())).toEqual([]);
  });

  it("flags em dashes anywhere", () => {
    const d = clean();
    d.voice_signature.read = "Short — declarative.";
    const v = lintDiagnosis(d);
    expect(v.some((x) => x.rule === "no-em-dash" && x.path === "voice_signature.read")).toBe(true);
  });

  it("flags hashtags", () => {
    const d = clean();
    d.unsaid_patterns[0]!.idea = "Write the #burnout post";
    expect(lintDiagnosis(d).some((x) => x.rule === "no-hashtag")).toBe(true);
  });

  it("flags hedging in strategist prose but tolerates quotes in evidence fields", () => {
    const d = clean();
    d.outside_in_gap.read = "It seems like you avoid big conversations.";
    d.intellectual_fingerprint.owned_positions[0] = '"I think most founders overrate polish" stated 4 times, Jan 2026 to May 2026';
    const v = lintDiagnosis(d);
    expect(v.some((x) => x.rule === "no-hedging" && x.path === "outside_in_gap.read")).toBe(true);
    expect(v.some((x) => x.path.startsWith("owned_positions"))).toBe(false);
  });

  it("flags an overlong headline", () => {
    const d = clean();
    d.headline = "One. Two. Three. Four sentences is too many for an opener.";
    expect(lintDiagnosis(d).some((x) => x.rule === "headline-too-long")).toBe(true);
  });

  it("requires dates on owned positions and contradictions", () => {
    const d = clean();
    d.intellectual_fingerprint.owned_positions = ["Distribution beats product, said many times"];
    d.consistency_audit[0]!.tension = "You praised venture and damned it";
    const v = lintDiagnosis(d);
    expect(v.filter((x) => x.rule === "needs-date")).toHaveLength(2);
  });

  it("rejects unsaid patterns with no real evidence", () => {
    const d = clean();
    d.unsaid_patterns[0]!.evidence = "vibes";
    expect(lintDiagnosis(d).some((x) => x.rule === "needs-evidence")).toBe(true);
  });

  it("flags a read field that runs past 3 sentences", () => {
    const d = clean();
    d.voice_signature.read =
      "You write short. You write declarative. You avoid hashtags entirely. Your variation coefficient sits at 0.71 which is alive.";
    const v = lintDiagnosis(d);
    expect(v.some((x) => x.rule === "read-too-long" && x.path === "voice_signature.read")).toBe(true);
  });

  it("flags a read field that is too long by characters even at 3 sentences", () => {
    const d = clean();
    d.outside_in_gap.read = `${"Your posting pattern leans heavily toward announcing your own work and thinking rather than entering conversations that are already happening around you in your space, ".repeat(3)}which is a ratio problem.`;
    expect(lintDiagnosis(d).some((x) => x.rule === "read-too-long" && x.path === "outside_in_gap.read")).toBe(true);
  });

  it("flags paragraph-length array entries", () => {
    const d = clean();
    d.outside_in_gap.missed_swings = [
      "The May 2026 OpenAI pricing storm was the single biggest conversation in your space this year and it passed without a word from you, even though you had written adjacent material about platform pricing three separate times before it happened and your audience would clearly have expected you to weigh in, which makes it a costly silence and one worth understanding since these moments are exactly where outside-in posting builds reach.",
    ];
    expect(lintDiagnosis(d).some((x) => x.rule === "entry-too-long" && x.path === "missed_swings[0]")).toBe(true);
  });

  it("renders violations as a corrective instruction", () => {
    const d = clean();
    d.headline = "Vague — thing.";
    const text = violationInstruction(lintDiagnosis(d));
    expect(text).toContain("no-em-dash");
    expect(text).toContain("headline");
  });
});
