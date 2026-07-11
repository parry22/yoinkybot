import { describe, expect, it } from "vitest";
import { normalizeArray, PROFILE_FIELDS, FIELD_STAGE } from "./profile.js";

describe("normalizeArray", () => {
  it("passes a real array through unchanged", () => {
    expect(normalizeArray(["naval", "dan koe"])).toEqual(["naval", "dan koe"]);
  });
  it("parses a double-encoded JSON array string (the real bug seen live)", () => {
    expect(normalizeArray('["naval","dan koe","justin welsh"]')).toEqual(["naval", "dan koe", "justin welsh"]);
  });
  it("falls back to comma-splitting a plain string", () => {
    expect(normalizeArray("naval, dan koe, justin welsh")).toEqual(["naval", "dan koe", "justin welsh"]);
  });
  it("returns an empty array for an empty string", () => {
    expect(normalizeArray("")).toEqual([]);
  });
  it("does not choke on malformed bracket text", () => {
    expect(normalizeArray("[not really json]")).toEqual(["[not really json]"]);
  });
});

describe("PROFILE_FIELDS / FIELD_STAGE", () => {
  it("every field has a stage", () => {
    for (const f of PROFILE_FIELDS) expect(FIELD_STAGE[f]).toBeTypeOf("number");
  });
  it("is the trimmed 8-field set (2026-07-11)", () => {
    expect(PROFILE_FIELDS).toEqual([
      "niche",
      "primary_goal",
      "audience_who",
      "inspiration_creators",
      "tone_selections",
      "content_pillars",
      "camera_comfort",
      "primary_platform",
    ]);
  });
});
