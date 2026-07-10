import { describe, it, expect } from "vitest";
import { enforceStyle, casualize } from "./style.js";

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

describe("casualize", () => {
  it("lowercases the opening letter of an ordinary sentence", () => {
    expect(casualize("On it, drafting that now.")).toBe("on it, drafting that now.");
    expect(casualize("Got it.")).toBe("got it.");
  });

  it("still applies enforceStyle (em dashes, hashtags)", () => {
    expect(casualize("Cool — pulling your history #now")).toBe("cool, pulling your history");
  });

  it("leaves a proper-noun or acronym opener capitalized", () => {
    // Would read as "linkedIn"/"aI" if we blindly lowercased char 0.
    expect(casualize("LinkedIn is where you're quiet.")).toBe("LinkedIn is where you're quiet.");
    expect(casualize("AI changed that.")).toBe("AI changed that.");
    expect(casualize("X is your main channel.")).toBe("X is your main channel.");
  });

  it("finds the first real letter past a leading emoji", () => {
    expect(casualize("✍️ Here you go:")).toBe("✍️ here you go:");
  });

  it("lowercases the pronoun 'I' opener into casual 'i'm'", () => {
    expect(casualize("I'm reading your history now.")).toBe("i'm reading your history now.");
  });

  it("handles empty input", () => {
    expect(casualize("")).toBe("");
  });
});
