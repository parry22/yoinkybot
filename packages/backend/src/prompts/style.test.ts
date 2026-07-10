import { describe, it, expect } from "vitest";
import { enforceStyle } from "./style.js";

describe("enforceStyle", () => {
  it("replaces em/en dashes with a comma clause break", () => {
    expect(enforceStyle("Distribution wins — always")).toBe("Distribution wins, always");
    expect(enforceStyle("a—b")).toBe("a, b");
    expect(enforceStyle("a–b")).toBe("a, b");
  });

  it("strips hashtags anywhere, preserving the surrounding text", () => {
    expect(enforceStyle("Ship it #buildinpublic")).toBe("Ship it");
    expect(enforceStyle("#growth is a lie")).toBe("is a lie");
    expect(enforceStyle("real talk #startup #founders done")).toBe("real talk done");
  });

  it("does not introduce doubled spaces or space-before-punctuation", () => {
    expect(enforceStyle("hey — really?")).toBe("hey, really?");
    expect(enforceStyle("one — two — three.")).toBe("one, two, three.");
  });

  it("collapses a dash that sits right before terminal punctuation", () => {
    expect(enforceStyle("that's the point —.")).toBe("that's the point.");
  });

  it("leaves clean text untouched", () => {
    const clean = "Short sentence. Then a longer one that carries the real weight of the idea.";
    expect(enforceStyle(clean)).toBe(clean);
  });

  it("handles empty input", () => {
    expect(enforceStyle("")).toBe("");
  });
});
