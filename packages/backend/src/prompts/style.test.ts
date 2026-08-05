import { describe, it, expect } from "vitest";
import { enforceStyle, casualize } from "./style.js";

describe("enforceStyle", () => {
  it("replaces em/en dashes with a comma clause break", () => {
    expect(enforceStyle("Distribution wins \u2014 always")).toBe("Distribution wins, always");
    expect(enforceStyle("a\u2014b")).toBe("a, b");
    expect(enforceStyle("a\u2013b")).toBe("a, b");
  });

  it("strips hashtags anywhere, preserving the surrounding text", () => {
    expect(enforceStyle("Ship it #buildinpublic")).toBe("Ship it");
    expect(enforceStyle("#growth is a lie")).toBe("is a lie");
    expect(enforceStyle("real talk #startup #founders done")).toBe("real talk done");
  });

  it("does not introduce doubled spaces or space-before-punctuation", () => {
    expect(enforceStyle("hey \u2014 really?")).toBe("hey, really?");
    expect(enforceStyle("one \u2014 two \u2014 three.")).toBe("one, two, three.");
  });

  it("collapses a dash that sits right before terminal punctuation", () => {
    expect(enforceStyle("that's the point \u2014.")).toBe("that's the point.");
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
  it("uses sentence case", () => {
    expect(casualize("on it, drafting that now. next step is ready.")).toBe("On it, drafting that now. Next step is ready.");
    expect(casualize("got it.")).toBe("Got it.");
  });

  it("still applies enforceStyle (em dashes, hashtags)", () => {
    expect(casualize("cool \u2014 pulling your history #now")).toBe("Cool, pulling your history");
  });

  it("leaves a proper-noun or acronym opener capitalized", () => {
    // Would read as "linkedIn"/"aI" if we blindly lowercased char 0.
    expect(casualize("LinkedIn is where you're quiet.")).toBe("LinkedIn is where you're quiet.");
    expect(casualize("AI changed that.")).toBe("AI changed that.");
    expect(casualize("X is your main channel.")).toBe("X is your main channel.");
  });

  it("capitalizes the first real letter past a leading emoji", () => {
    expect(casualize("✍️ here you go:")).toBe("✍️ Here you go:");
  });

  it("capitalizes a lowercase pronoun at the start", () => {
    expect(casualize("i'm reading your history now.")).toBe("I'm reading your history now.");
  });

  it("handles empty input", () => {
    expect(casualize("")).toBe("");
  });
});
