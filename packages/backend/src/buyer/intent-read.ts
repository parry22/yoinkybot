/**
 * Buyer Radar annotation step. Candidates that cleared the deterministic intent
 * gate and the semantic niche gate get ONE batched, cheap LLM call that says what
 * each person is actually asking for. It does not draft a reply and it cannot
 * remove anyone — see prompts/buyer-intent-read.v1.ts for why that changed.
 *
 * Everything here is best-effort by construction. If the model is down, returns
 * garbage, or skips ids, each affected candidate falls back to a deterministic
 * `why` built from its own scoring components. A lead never disappears because
 * the annotation failed; it just gets a plainer line under it.
 */
import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { buyerIntentRead } from "../prompts/buyer-intent-read.v1.js";
import { casualize } from "../prompts/style.js";
import type { IcpProfile } from "./icp.js";
import type { GatedCandidate } from "./niche-gate.js";
import type { IntentType } from "./scoring.js";

export interface IntentRead {
  /** Yoinky's one-line read of what this person wants. Always present. */
  why: string;
  /** The intent bucket, model-refined where it read the tweet differently. */
  intentType: IntentType;
  /** 0-1, ordering only — never used to drop a candidate. */
  confidence: number;
}

const INTENT_TYPES: IntentType[] = ["explicit_ask", "competitor_dissatisfaction", "pain", "trigger_event"];

const readsSchema = z.object({
  reads: z
    .array(
      z.object({
        id: z.string(),
        intent: z.string().catch(""),
        why: z.string().catch(""),
        confidence: z.coerce.number().catch(0.5),
      }),
    )
    .catch([]),
});

const BUCKET_PHRASE: Record<IntentType, string> = {
  explicit_ask: "asking outright for a recommendation",
  competitor_dissatisfaction: "unhappy with something they already use",
  pain: "describing the problem you solve",
  trigger_event: "just hit the moment that creates the need",
};

/**
 * The line shown when the model didn't annotate this candidate. Built from the
 * deterministic components, so it is always true even though it is plainer.
 */
export function fallbackWhy(candidate: GatedCandidate, ageHours: number): string {
  const bits = [BUCKET_PHRASE[candidate.provenance]];
  if (ageHours < 24) bits.push(`posted ${Math.max(1, Math.round(ageHours))}h ago`);
  else bits.push(`posted ${Math.round(ageHours / 24)}d ago`);
  const followers = candidate.tweet.authorFollowers;
  if (followers > 0) bits.push(`${formatFollowers(followers)} followers`);
  if (candidate.tweet.replyCount === 0) bits.push("no replies yet, you'd be first");
  return casualize(bits.join(" · "));
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Annotate a batch. Returns a map keyed by tweet id — always complete, because
 * anything the model didn't cover is filled from `fallbackWhy`.
 */
export async function readIntents(
  userId: string,
  icp: IcpProfile,
  candidates: GatedCandidate[],
  now = Date.now(),
): Promise<Map<string, IntentRead>> {
  const ageOf = (c: GatedCandidate) => (now - c.tweet.createdAt.getTime()) / 3_600_000;
  const out = new Map<string, IntentRead>();
  for (const c of candidates) {
    out.set(c.tweet.id, {
      why: fallbackWhy(c, ageOf(c)),
      intentType: c.provenance,
      confidence: 0.5,
    });
  }
  if (candidates.length === 0) return out;

  try {
    const res = await llmCall({
      userId,
      eventType: "compose",
      tier: buyerIntentRead.tier,
      system: buyerIntentRead.system,
      user: buyerIntentRead.render({
        productOneliner: icp.product_oneliner ?? "",
        buyerDescription: icp.buyer_description ?? "",
        candidates: candidates.map((c) => ({
          id: c.tweet.id,
          handle: c.tweet.authorHandle,
          text: c.tweet.text,
          bucket: c.provenance,
          ageHours: ageOf(c),
        })),
      }),
      json: true,
      maxTokens: 120 * candidates.length + 200,
    });
    const parsed = readsSchema.parse(res.parsed);
    for (const r of parsed.reads) {
      const existing = out.get(r.id);
      if (!existing) continue; // hallucinated id — ignore, never widens the set
      const why = r.why.trim();
      out.set(r.id, {
        why: why ? casualize(why).slice(0, 400) : existing.why,
        intentType: (INTENT_TYPES as string[]).includes(r.intent) ? (r.intent as IntentType) : existing.intentType,
        confidence: Number.isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : existing.confidence,
      });
    }
  } catch (err) {
    // Loud, but never fatal — every candidate already has its deterministic line.
    console.error("buyer intent read failed; falling back to deterministic reasons", err);
  }
  return out;
}
