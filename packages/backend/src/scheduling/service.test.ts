import { describe, expect, it } from "vitest";
import { containsLink } from "./service.js";

describe("containsLink", () => {
  it("catches an https URL", () => {
    expect(containsLink("check this out https://example.com/post")).toBe(true);
  });
  it("catches a bare www. link", () => {
    expect(containsLink("go read www.example.com/thing")).toBe(true);
  });
  it("catches a bare domain-style link with no scheme", () => {
    expect(containsLink("more at meetyoinky.com")).toBe(true);
  });
  it("does not false-positive on ordinary punctuation", () => {
    expect(containsLink("shipping this today, e.g. the onboarding flow")).toBe(false);
  });
  it("does not false-positive on a version number", () => {
    expect(containsLink("upgraded to GLM 5.2 and it's noticeably better")).toBe(false);
  });
  it("does not false-positive on plain sentences with periods", () => {
    expect(containsLink("this is a normal post. nothing weird here. just thoughts.")).toBe(false);
  });
  it("passes clean, link-free content", () => {
    expect(containsLink("here's the thing nobody tells you about shipping fast")).toBe(false);
  });
});
