import { describe, expect, it } from "vitest";
import { cosineDistance, goalBlock, toneBlock } from "./gap.js";
import type { BrandProfile } from "./profile.js";
import type { VoiceStats } from "../lib/voice-stats.js";

const profile = (o: Partial<BrandProfile> = {}): BrandProfile =>
  ({
    id: "p",
    user_id: "u",
    version: 1,
    niche: null,
    sub_niche_angle: null,
    credibility_source: null,
    unique_pov: null,
    primary_goal: null,
    secondary_goals: [],
    audience_who: null,
    audience_sophistication: null,
    audience_pain_point: null,
    inspiration_creators: [],
    tone_selections: [],
    formality_gradient: null,
    vulnerability_threshold: null,
    content_pillars: [],
    content_pillars_confirmed: false,
    camera_comfort: null,
    visual_comfort: null,
    primary_platform: null,
    platform_adaptation: null,
    posting_capacity: null,
    employer_restrictions: null,
    topics_off_limits: [],
    anonymity_needs: null,
    unresolved: [],
    profile_completed_at: null,
    created_at: "",
    updated_at: "",
    ...o,
  }) as BrandProfile;

const voice = (o: Partial<VoiceStats> = {}): VoiceStats => ({
  postCount: 30,
  meanSentenceLen: 15,
  sentenceLenCv: 0.5,
  shortSentencePct: 20,
  longSentencePct: 10,
  perPost: { emDashes: 0, semicolons: 0, exclamations: 1, questions: 0.5, hashtags: 0 },
  lowercaseStartPct: 10,
  hedgesPerPost: 0.2,
  drift: null,
  ...o,
});

describe("cosineDistance", () => {
  it("is 0 for identical direction, ~1 for orthogonal", () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
  });
  it("returns 1 when a vector is zero (undefined direction)", () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
  });
});

describe("goalBlock", () => {
  it("flags an outward goal drowning in inside-out content", () => {
    const r = goalBlock(profile({ primary_goal: "leads" }), { insideOut: 80, outsideIn: 20, classified: 100 });
    expect(r.insideOutPct).toBe(80);
    expect(r.text).toContain("MISMATCH");
  });
  it("does not flag when the mix leaves room", () => {
    const r = goalBlock(profile({ primary_goal: "leads" }), { insideOut: 40, outsideIn: 60, classified: 100 });
    expect(r.text).not.toContain("MISMATCH");
  });
  it("is honest when there's no goal or too little data", () => {
    expect(goalBlock(profile(), null).insideOutPct).toBeNull();
    expect(goalBlock(profile({ primary_goal: "leads" }), null).text).toContain("too few");
  });
});

describe("toneBlock", () => {
  it("flags structured tones against clipped writing", () => {
    const t = toneBlock(profile({ tone_selections: ["authority.analytical"] }), voice({ meanSentenceLen: 6 }));
    expect(t).toContain("structured/analytical");
  });
  it("names a cross-cluster tension", () => {
    const t = toneBlock(
      profile({ tone_selections: ["authority.analytical", "reach.shitpost"] }),
      voice({ meanSentenceLen: 15 }),
    );
    expect(t.toLowerCase()).toContain("different directions");
  });
  it("flags trust modes against zero vulnerability", () => {
    const t = toneBlock(
      profile({ tone_selections: ["trust.confessional"], vulnerability_threshold: "none" }),
      voice(),
    );
    expect(t).toContain("vulnerability to none");
  });
  it("is honest when nothing is selected or measurable", () => {
    expect(toneBlock(profile(), voice())).toContain("no tones selected");
    expect(toneBlock(profile({ tone_selections: ["authority.data"] }), null)).toContain("too few posts");
  });
});
