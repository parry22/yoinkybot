import type { Prompt } from "./types.js";
import { CASUAL_VOICE } from "./style.js";

export interface BuyerIntentReadVars {
  productOneliner: string;
  buyerDescription: string;
  /** The candidates to read, pre-numbered so the model can address them by id. */
  candidates: Array<{ id: string; handle: string; text: string; bucket: string; ageHours: number }>;
}

/**
 * Reads a BATCH of already-gated candidates and says, in one line each, what the
 * person is actually after. It does not write a reply and it does not decide who
 * is shown - both of those were the old buyer-outreach prompt's job.
 *
 * WHY IT CHANGED. The old flow ran a per-candidate agent loop that drafted a
 * reply and could return fires:false. That made the model the last gate, which
 * broke two things at once: an empty radar was usually the model declining
 * everything rather than search finding nothing, and every lead cost a bounded
 * agent loop, so the per-scan ceiling had to stay tiny. Selection is now entirely
 * code's (buyer/scan.ts); this is one cheap batched call that only annotates.
 *
 * `confidence` is returned for ORDERING ONLY. The caller never drops a candidate
 * on it - a low-confidence lead sorts last, it does not disappear.
 */
export const buyerIntentRead: Prompt<BuyerIntentReadVars> = {
  id: "buyer-intent-read",
  version: 1,
  tier: "cheap",
  system: `You read tweets and say, in one line each, what the person is in the market for.

For EVERY candidate you are given, return an entry. Never skip one, never merge two,
never invent an id that wasn't given to you.

Each entry has:
- "id": exactly the id given.
- "intent": one of explicit_ask | competitor_dissatisfaction | pain | trigger_event - what
  the tweet actually shows, which may differ from the bucket it was found under.
- "why": ONE short line, to the seller, naming the specific thing this person said they
  want and how it lines up with what the seller offers. Quote or paraphrase their actual
  words. No pitch, no reply draft, no advice on what to say - just the read.
- "confidence": 0.0-1.0, how genuinely in-market this reads. Low is fine and useful; it
  sorts the list. It does NOT remove anyone, so never use 0 as a way to reject a candidate.

Be honest in "why". If someone is only adjacent to what the seller does, say that plainly
("close but they're asking about X, not Y") rather than stretching it into a fit.

${CASUAL_VOICE}

Respond with ONLY valid JSON:
{"reads":[{"id":"...","intent":"explicit_ask","why":"...","confidence":0.0}]}`,
  render: ({ productOneliner, buyerDescription, candidates }) =>
    [
      `THE SELLER`,
      `sells: ${productOneliner || "(not stated)"}`,
      `buyer: ${buyerDescription || "(not stated)"}`,
      ``,
      `CANDIDATES (${candidates.length}) - return one entry per id:`,
      ...candidates.map(
        (c) =>
          `[${c.id}] @${c.handle} · found as ${c.bucket} · ${Math.round(c.ageHours)}h old\n${c.text.slice(0, 400)}`,
      ),
    ].join("\n"),
};
