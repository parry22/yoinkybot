/**
 * Buyer Radar scan orchestrator: the full pipeline for one user —
 *   discovery → DETERMINISTIC intent gate → SEMANTIC niche gate → composition
 *   agent → persist.
 * Code decides selection at every step; the model only researches/drafts/declines.
 *
 * The monthly budget is checked BEFORE any paid twitterapi.io call (same spirit
 * as the niche gate running before paid work in the macro-moment pipeline). A
 * fired signal consumes budget; a model decline is recorded (for dedup + tuning)
 * but does NOT. Never sends — surfaces approval-only drafts.
 */
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { getIcp, icpComplete } from "./icp.js";
import { discoverCandidates } from "./discovery.js";
import { intentScore, type IntentComponents } from "./scoring.js";
import { applyNicheGate } from "./niche-gate.js";
import { composeOutreach } from "./radar-agent.js";
import { effectiveThresholds } from "./calibration.js";

/** Hard cap on composition (LLM) calls per scan, independent of budget — bounds cost. */
const MAX_COMPOSE_PER_SCAN = 8;

export type ScanStatus = "ok" | "no_icp" | "unavailable" | "budget_exhausted";

export interface ScanResult {
  status: ScanStatus;
  surfaced: number;
  declined: number;
  remaining: number;
}

/** Signals actually shown this calendar month (declines don't count). */
export async function monthlySurfacedCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM buyer_signals
     WHERE user_id = $1 AND verdict <> 'rejected' AND surfaced_at >= date_trunc('month', now())`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

async function persistSignal(
  userId: string,
  tweet: { id: string; text: string; url: string | null; authorHandle: string; authorName: string; authorFollowers: number; createdAt: Date },
  fields: {
    score: number;
    components: IntentComponents;
    intentType: string;
    nicheSimilarity: number;
    verdict: "surfaced" | "rejected";
    verdictReason: string | null;
    why: string | null;
    draftReply: string | null;
    receiptRef: string | null;
    agentSteps: unknown;
  },
): Promise<void> {
  await query(
    `INSERT INTO buyer_signals
       (user_id, profile_id, tweet_id, author_handle, author_name, author_followers, content, url,
        score, components, intent_type, niche_similarity, why, draft_reply, receipt_ref, agent_steps,
        verdict, verdict_reason, posted_at)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (user_id, tweet_id) DO NOTHING`,
    [
      userId,
      tweet.id,
      tweet.authorHandle,
      tweet.authorName || null,
      tweet.authorFollowers || null,
      tweet.text,
      tweet.url,
      fields.score,
      JSON.stringify(fields.components),
      fields.intentType,
      fields.nicheSimilarity,
      fields.why,
      fields.draftReply,
      fields.receiptRef,
      JSON.stringify(fields.agentSteps ?? []),
      fields.verdict,
      fields.verdictReason,
      tweet.createdAt.toISOString(),
    ],
  );
}

/**
 * Run one full scan for a user. Safe to call on-demand (web "Scan now") or from
 * the recurring job. Returns a status the caller turns into UI/messaging.
 */
export async function scanForUser(userId: string): Promise<ScanResult> {
  const empty = (status: ScanStatus, remaining = 0): ScanResult => ({ status, surfaced: 0, declined: 0, remaining });

  if (!config.BUYER_RADAR_ENABLED || !config.TWITTERAPI_IO_KEY) return empty("unavailable");

  const icp = await getIcp(userId);
  if (!icpComplete(icp) || !icp) return empty("no_icp");

  // Budget FIRST, before any paid search.
  const used = await monthlySurfacedCount(userId);
  let remaining = config.BUYER_MONTHLY_SIGNAL_CAP - used;
  if (remaining <= 0) return empty("budget_exhausted", 0);

  // Per-user calibrated gates (falls back to config defaults) — recalibrated
  // from the user's verdicts (buyer/calibration.ts).
  const thresholds = await effectiveThresholds(userId);

  const candidates = await discoverCandidates(userId, icp);
  if (candidates.length === 0) return { status: "ok", surfaced: 0, declined: 0, remaining };

  // DETERMINISTIC intent gate.
  const ctx = {
    competitorTerms: icp.competitor_terms,
    painSignals: icp.pain_signals,
    exclusions: icp.exclusions,
    lookbackHours: config.BUYER_LOOKBACK_HOURS,
  };
  const scored = candidates
    .map((c) => ({ c, ...intentScore({ text: c.tweet.text, authorFollowers: c.tweet.authorFollowers, replyCount: c.tweet.replyCount, createdAt: c.tweet.createdAt, provenance: c.provenance }, ctx) }))
    .filter((s) => s.score >= thresholds.intent)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { status: "ok", surfaced: 0, declined: 0, remaining };

  // SEMANTIC niche gate (needs an embedding call per candidate — only on intent-passers).
  const gated = await applyNicheGate(
    userId,
    scored.map((s) => s.c),
    thresholds.niche,
  );
  const scoreById = new Map(scored.map((s) => [s.c.tweet.id, s]));

  let surfaced = 0;
  let declined = 0;
  let composed = 0;
  for (const g of gated) {
    if (surfaced >= remaining || composed >= MAX_COMPOSE_PER_SCAN) break;
    const s = scoreById.get(g.tweet.id);
    if (!s) continue;
    composed++;
    const outreach = await composeOutreach(userId, g);
    if (outreach.fires) {
      await persistSignal(userId, g.tweet, {
        score: s.score,
        components: s.components,
        intentType: outreach.intentType,
        nicheSimilarity: g.nicheSimilarity,
        verdict: "surfaced",
        verdictReason: null,
        why: outreach.why,
        draftReply: outreach.draftReply,
        receiptRef: outreach.receiptRef,
        agentSteps: outreach.steps,
      });
      surfaced++;
    } else {
      // Recorded so it's deduped and feeds tuning; does NOT burn budget.
      await persistSignal(userId, g.tweet, {
        score: s.score,
        components: s.components,
        intentType: outreach.intentType,
        nicheSimilarity: g.nicheSimilarity,
        verdict: "rejected",
        verdictReason: "model declined (not genuine intent)",
        why: null,
        draftReply: null,
        receiptRef: null,
        agentSteps: outreach.steps,
      });
      declined++;
    }
  }

  remaining = Math.max(0, config.BUYER_MONTHLY_SIGNAL_CAP - (used + surfaced));
  return { status: "ok", surfaced, declined, remaining };
}
