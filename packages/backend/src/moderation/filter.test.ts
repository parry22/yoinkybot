import { describe, expect, it } from "vitest";
import { moderateText } from "./filter.js";

describe("moderateText", () => {
  it("allows ordinary professional text", () => {
    expect(moderateText("Looking for feedback on my B2B SaaS onboarding flow.").ok).toBe(true);
    expect(moderateText("this launch is hard but we're shipping").ok).toBe(true);
  });

  it("blocks explicit sexual content", () => {
    expect(moderateText("check out my onlyfans for nudes").ok).toBe(false);
    expect(moderateText("free porn here").category).toBe("sexual");
  });

  it("blocks abusive slurs and hostile intent", () => {
    expect(moderateText("you absolute retard").ok).toBe(false);
    expect(moderateText("kill yourself").category).toBe("abusive");
  });

  it("does not false-positive on words that merely CONTAIN a flagged substring", () => {
    // Scunthorpe problem: word boundaries must prevent these.
    expect(moderateText("I booked a therapist appointment").ok).toBe(true);
    expect(moderateText("welcome to Scunthorpe").ok).toBe(true);
    expect(moderateText("class assessment analysis").ok).toBe(true);
  });

  it("treats empty input as clean", () => {
    expect(moderateText("").ok).toBe(true);
  });
});
