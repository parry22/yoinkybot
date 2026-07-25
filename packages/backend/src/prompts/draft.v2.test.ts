import { describe, expect, it } from "vitest";
import { draftPostV2 } from "./draft.v2.js";
import { EMPTY_EVIDENCE, type DraftEvidence } from "../drafting/evidence.js";

const baseVars = {
  request: "a post about pricing",
  platform: "x" as const,
  memories: [{ id: "m1", content: "pricing should be legible", kind: "claim" }],
  voiceTraits: { tone: ["direct"] },
  evidence: EMPTY_EVIDENCE,
};

const fullEvidence: DraftEvidence = {
  baselineEngagement: 40,
  postsConsidered: 60,
  topPosts: [
    {
      text: "most pricing pages are written for the seller, not the buyer.",
      engagement: 320,
      ratio: 8,
      mode: "assertion",
      sincerity: "sincere",
      motive: "authority_building",
      opener: "bold_claim",
      chars: 61,
      daysAgo: 12,
    },
  ],
  quietPosts: [{ text: "morning all", engagement: 3, ratio: 0.1, mode: null, sincerity: null, motive: null, opener: "plain", chars: 11, daysAgo: 30 }],
  shapeLift: [
    { label: "longer take (≥240 chars)", posts: 14, liftPct: 62 },
    { label: "short & punchy (≤120 chars)", posts: 20, liftPct: -35 },
  ],
  motiveLift: [{ motive: "authority_building", posts: 9, liftPct: 51 }],
};

describe("draft.v2 system prompt", () => {
  it("carries the reconciliation rule so measured data outranks generic doctrine", () => {
    expect(draftPostV2.system).toContain("THE RECONCILIATION RULE");
    expect(draftPostV2.system).toContain("THEIR DATA WINS");
  });

  it("forbids leaking metrics into the draft itself", () => {
    expect(draftPostV2.system).toMatch(/[Nn]ever mention metrics/);
  });

  it("tells the writer not to copy past wording", () => {
    expect(draftPostV2.system).toMatch(/Do NOT copy a past post's wording/);
  });

  it("keeps a monotonic version above the v1 file's internal version 2", () => {
    expect(draftPostV2.version).toBe(3);
    expect(draftPostV2.id).toBe("draft");
  });
});

describe("draft.v2 render", () => {
  it("omits every evidence block when there is no evidence (cold account)", () => {
    const out = draftPostV2.render(baseVars);
    expect(out).not.toContain("ACTUALLY LANDED");
    expect(out).not.toContain("WHICH SHAPE OF POST");
    expect(out).not.toContain("WHICH INTENT");
    expect(out).not.toContain("QUIETEST");
    // still renders the essentials
    expect(out).toContain("Request: a post about pricing");
    expect(out).toContain("[m1]");
  });

  it("renders top posts with their real numbers, register and intent", () => {
    const out = draftPostV2.render({ ...baseVars, evidence: fullEvidence });
    expect(out).toContain("ACTUALLY LANDED");
    expect(out).toContain("8x your median");
    expect(out).toContain("320 engagements");
    expect(out).toContain("intent: authority_building");
    expect(out).toContain("opens with a bold claim");
    expect(out).toContain("median of 40 engagements across 60 posts");
  });

  it("signs shape lift both ways so an underperforming shape is unmistakable", () => {
    const out = draftPostV2.render({ ...baseVars, evidence: fullEvidence });
    expect(out).toContain("longer take (≥240 chars): +62%");
    expect(out).toContain("short & punchy (≤120 chars): -35%");
  });

  it("surfaces the motive lift (the previously-unread classifier column)", () => {
    const out = draftPostV2.render({ ...baseVars, evidence: fullEvidence });
    expect(out).toContain("WHICH INTENT WORKS FOR THIS PERSON");
    expect(out).toContain("authority_building: +51%");
  });

  it("labels a published memory distinctly from private thinking", () => {
    const out = draftPostV2.render({
      ...baseVars,
      memories: [
        { id: "pub", content: "already said this", kind: "claim", published: true, engagement: 120, motive: "authority_building" },
        { id: "priv", content: "half-formed idea", kind: "idea", published: false },
      ],
    });
    expect(out).toContain("PUBLISHED POST, 120 engagements, intent: authority_building");
    expect(out).toContain("private thinking, never posted");
  });
});
