import { describe, expect, it } from "vitest";
import { intentScore, reachabilityBand, type IcpScoringContext, type IntentCandidate } from "./scoring.js";

const NOW = 1_700_000_000_000; // fixed clock so recency is deterministic

const candidate = (over: Partial<IntentCandidate>): IntentCandidate => ({
  text: "hello world",
  authorFollowers: 5000,
  replyCount: 0,
  createdAt: new Date(NOW),
  provenance: "explicit_ask",
  ...over,
});

const ctx = (over: Partial<IcpScoringContext> = {}): IcpScoringContext => ({
  competitorTerms: [],
  painSignals: [],
  exclusions: [],
  lookbackHours: 72,
  now: NOW,
  ...over,
});

describe("reachabilityBand", () => {
  it("is a band, not monotonic — a mid-size account beats an egg AND a megaphone", () => {
    const egg = reachabilityBand(12);
    const mid = reachabilityBand(8000);
    const megaphone = reachabilityBand(2_000_000);
    expect(mid).toBeGreaterThan(egg);
    expect(mid).toBeGreaterThan(megaphone);
    expect(mid).toBe(1);
  });
  it("peaks across the 1k-50k sweet spot", () => {
    expect(reachabilityBand(1000)).toBe(1);
    expect(reachabilityBand(50_000)).toBe(1);
    expect(reachabilityBand(200_000)).toBeLessThan(1);
  });
});

describe("intentScore markers", () => {
  it("scores an explicit ask well above vague pain", () => {
    const ask = intentScore(candidate({ text: "anyone recommend a good copywriter?" }), ctx());
    const vague = intentScore(candidate({ text: "ugh mondays", provenance: "pain" }), ctx());
    expect(ask.score).toBeGreaterThan(vague.score);
    expect(ask.components.marker).toBeGreaterThan(vague.components.marker);
  });

  it("folds per-user pain_signals into the strong lexicon", () => {
    const withSignal = intentScore(candidate({ text: "my checkout is leaking revenue" }), ctx({ painSignals: ["leaking revenue"] }));
    expect(withSignal.components.marker).toBeGreaterThanOrEqual(0.75);
  });
});

describe("intentScore competitor + question", () => {
  it("boosts on a competitor mention", () => {
    const hit = intentScore(candidate({ text: "thinking of switching from mailchimp" }), ctx({ competitorTerms: ["mailchimp"] }));
    expect(hit.components.competitor).toBe(1);
  });
  it("rewards a question mark", () => {
    expect(intentScore(candidate({ text: "what do you use for email?" }), ctx()).components.question).toBe(1);
  });
});

describe("crowding penalty (the inversion)", () => {
  it("prefers fewer existing replies — the opposite of buzz", () => {
    const early = intentScore(candidate({ text: "looking for a designer", replyCount: 0 }), ctx());
    const buried = intentScore(candidate({ text: "looking for a designer", replyCount: 80 }), ctx());
    expect(early.components.crowding).toBeGreaterThan(buried.components.crowding);
    expect(buried.components.crowding).toBe(0);
    expect(early.score).toBeGreaterThan(buried.score);
  });
});

describe("recency decay", () => {
  it("decays steeply — a stale ask scores far below a fresh one", () => {
    const fresh = intentScore(candidate({ text: "looking for a copywriter", createdAt: new Date(NOW) }), ctx());
    const old = intentScore(
      candidate({ text: "looking for a copywriter", createdAt: new Date(NOW - 60 * 3_600_000) }),
      ctx(),
    );
    expect(fresh.components.recency).toBeGreaterThan(old.components.recency);
    expect(old.components.recency).toBeLessThan(0.1);
  });
});

describe("exclusion hard-kill", () => {
  it("zeroes the score on any exclusion hit, regardless of loud intent", () => {
    const killed = intentScore(
      candidate({ text: "copywriter looking for freelance clients, dms open" }),
      ctx({ exclusions: ["looking for freelance clients"] }),
    );
    expect(killed.components.excluded).toBe(true);
    expect(killed.score).toBe(0);
  });
});

describe("provenance", () => {
  it("weights explicit_ask above trigger_event for identical text", () => {
    const explicit = intentScore(candidate({ provenance: "explicit_ask" }), ctx());
    const trigger = intentScore(candidate({ provenance: "trigger_event" }), ctx());
    expect(explicit.components.provenance).toBeGreaterThan(trigger.components.provenance);
    expect(explicit.intent_type).toBe("explicit_ask");
  });
});
