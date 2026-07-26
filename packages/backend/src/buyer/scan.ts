/**
 * Buyer Radar scan orchestrator: the full pipeline for one user —
 *   discovery → DETERMINISTIC intent gate → SEMANTIC niche gate → batched intent
 *   read → persist.
 * Code decides selection at every step; the model only annotates what code chose.
 *
 * The monthly budget is checked BEFORE any paid twitterapi.io call (same spirit
 * as the niche gate running before paid work in the macro-moment pipeline).
 * Never sends, never drafts a reply — it surfaces prospects and what they asked for.
 *
 * THE TARGET IS SIX. A scan that returns nothing is worse than a scan that
 * returns six imperfect leads: the user can skip a weak lead in a second, but
 * they cannot act on an empty screen, and "no signals" is indistinguishable from
 * "this product is broken". So both gates below are RANKERS WITH FLOORS rather
 * than cliffs — everything clearing the threshold passes, and if that leaves
 * fewer than six, the next-best candidates backfill. Supply, not the gates, is
 * what limits a scan now. Exclusions are the one hard kill that never backfills:
 * those are the user's own "this is not my buyer" and outrank the target.
 */
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { getIcp, icpComplete } from "./icp.js";
import { discoverCandidates, type DiscoveryTrace } from "./discovery.js";
import { intentScore, type IntentComponents } from "./scoring.js";
import { applyNicheGate } from "./niche-gate.js";
import { readIntents } from "./intent-read.js";
import { effectiveThresholds } from "./calibration.js";

/**
 * Leads a scan aims to surface. Six is the product promise, not a ceiling
 * discovered by tuning: it is enough to give the user a real choice in one
 * sitting and small enough that they actually work through it.
 */
export const TARGET_SIGNALS_PER_SCAN = 6;

/**
 * Supply target handed to discovery. Several times the surfacing target on
 * purpose — both gates subtract, so asking search for exactly six reliably ends
 * with two.
 */
const CANDIDATE_TARGET = TARGET_SIGNALS_PER_SCAN * 5;

export type ScanStatus = "ok" | "no_icp" | "unavailable" | "budget_exhausted";

/**
 * Where the funnel emptied out. Without this, "0 signals" is indistinguishable
 * from "the pipeline is broken" — which is exactly how a dead query set stayed
 * invisible. Cheap to carry, and the UI turns it into a plain-language reason.
 */
export interface ScanStages {
  /** Tweets returned by discovery after dedup/pre-filtering. */
  candidates: number;
  /** Cleared the deterministic intent gate on its own merits. */
  intentPassed: number;
  /** Reached the niche gate, including backfill below the intent threshold. */
  intentConsidered: number;
  /** Cleared the semantic niche gate, including backfill. */
  nichePassed: number;
  /** Actually surfaced this scan. */
  surfaced: number;
  /** How many leads had to be backfilled past a threshold to reach the target. */
  backfilled: number;
  /** False when the ICP has no embedding, so the niche gate can't run. */
  hasIcpVector: boolean;
  /** What discovery had to do to find supply. */
  discovery: DiscoveryTrace;
}

export interface ScanResult {
  status: ScanStatus;
  surfaced: number;
  remaining: number | null;
  stages: ScanStages;
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
  tweet: {
    id: string;
    text: string;
    url: string | null;
    authorHandle: string;
    authorName: string;
    authorFollowers: number;
    createdAt: Date;
  },
  fields: {
    score: number;
    components: IntentComponents;
    intentType: string;
    nicheSimilarity: number;
    why: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO buyer_signals
       (user_id, profile_id, tweet_id, author_handle, author_name, author_followers, content, url,
        score, components, intent_type, niche_similarity, why, draft_reply, receipt_ref, agent_steps,
        verdict, verdict_reason, posted_at)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,NULL,'[]','surfaced',NULL,$13)
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
      tweet.createdAt.toISOString(),
    ],
  );
}

const EMPTY_DISCOVERY: DiscoveryTrace = { vocabulary: [], queriesRun: 0, rungs: [], llmQueries: false };

/**
 * Run one full scan for a user. Safe to call on-demand (web "Scan now") or from
 * the recurring job. Returns a status the caller turns into UI/messaging.
 */
export async function scanForUser(userId: string): Promise<ScanResult> {
  const stages: ScanStages = {
    candidates: 0,
    intentPassed: 0,
    intentConsidered: 0,
    nichePassed: 0,
    surfaced: 0,
    backfilled: 0,
    hasIcpVector: true,
    discovery: EMPTY_DISCOVERY,
  };
  const empty = (status: ScanStatus, remaining: number | null = 0): ScanResult => ({
    status,
    surfaced: 0,
    remaining,
    stages,
  });

  if (!config.BUYER_RADAR_ENABLED || !config.TWITTERAPI_IO_KEY) return empty("unavailable");

  const icp = await getIcp(userId);
  if (!icpComplete(icp) || !icp) return empty("no_icp");

  // Budget FIRST, before any paid search. Per-plan monthly cap. A null cap means
  // no monthly ceiling — the scan is then bounded only by the per-scan target.
  const cap = (await entitlementsFor(userId)).buyerIntentsPerMonth;
  const used = await monthlySurfacedCount(userId);
  const headroom = cap === null ? TARGET_SIGNALS_PER_SCAN : cap - used;
  if (cap !== null && headroom <= 0) return empty("budget_exhausted", 0);
  // Never surface more than the target in one scan, and never more than the
  // month has left.
  const targetThisScan = Math.min(TARGET_SIGNALS_PER_SCAN, headroom);

  // Per-user calibrated gates (falls back to config defaults) — recalibrated
  // from the user's verdicts (buyer/calibration.ts).
  const thresholds = await effectiveThresholds(userId);

  const discovery = await discoverCandidates(userId, icp, CANDIDATE_TARGET);
  stages.discovery = discovery.trace;
  stages.candidates = discovery.candidates.length;
  if (discovery.candidates.length === 0) {
    return { status: "ok", surfaced: 0, remaining: remainingAfter(cap, used, 0), stages };
  }

  // ── DETERMINISTIC intent gate, as a ranker with a floor. ──────────────────
  const ctx = {
    competitorTerms: icp.competitor_terms,
    painSignals: icp.pain_signals,
    exclusions: icp.exclusions,
    lookbackHours: config.BUYER_LOOKBACK_HOURS,
  };
  const scored = discovery.candidates
    .map((c) => ({
      c,
      ...intentScore(
        {
          text: c.tweet.text,
          authorFollowers: c.tweet.authorFollowers,
          replyCount: c.tweet.replyCount,
          createdAt: c.tweet.createdAt,
          provenance: c.provenance,
        },
        ctx,
      ),
    }))
    // An exclusion hit is the user's own "not my buyer". It is the one thing the
    // target never overrides, so it's dropped here and can't be backfilled.
    .filter((s) => !s.components.excluded)
    .sort((a, b) => b.score - a.score);

  const clearedIntent = scored.filter((s) => s.score >= thresholds.intent);
  stages.intentPassed = clearedIntent.length;
  // Backfill toward a niche-gate input several times the surfacing target: the
  // niche gate is about to subtract again.
  const nicheInputTarget = Math.min(scored.length, Math.max(targetThisScan * 3, clearedIntent.length));
  const considered = scored.slice(0, Math.max(clearedIntent.length, nicheInputTarget));
  stages.intentConsidered = considered.length;
  if (considered.length === 0) {
    return { status: "ok", surfaced: 0, remaining: remainingAfter(cap, used, 0), stages };
  }

  // ── SEMANTIC niche gate (one embedding call per considered candidate). ────
  const niche = await applyNicheGate(
    userId,
    considered.map((s) => s.c),
    { threshold: thresholds.niche, minKeep: targetThisScan },
  );
  stages.nichePassed = niche.passed.length;
  stages.hasIcpVector = niche.hasVector;
  if (niche.passed.length === 0) {
    return { status: "ok", surfaced: 0, remaining: remainingAfter(cap, used, 0), stages };
  }

  const scoreById = new Map(considered.map((s) => [s.c.tweet.id, s]));

  // Best-first by intent score, then take exactly what the target allows. The
  // annotation call below is one request for the whole batch, so this bounds it.
  const chosen = niche.passed
    .slice()
    .sort((a, b) => (scoreById.get(b.tweet.id)?.score ?? 0) - (scoreById.get(a.tweet.id)?.score ?? 0))
    .slice(0, targetThisScan);

  const reads = await readIntents(userId, icp, chosen);

  let surfaced = 0;
  let backfilled = 0;
  for (const g of chosen) {
    const s = scoreById.get(g.tweet.id);
    if (!s) continue;
    const read = reads.get(g.tweet.id);
    if (s.score < thresholds.intent || g.nicheSimilarity < 1 - thresholds.niche) backfilled++;
    try {
      await persistSignal(userId, g.tweet, {
        score: s.score,
        components: s.components,
        intentType: read?.intentType ?? g.provenance,
        nicheSimilarity: g.nicheSimilarity,
        why: read?.why ?? "",
      });
      surfaced++;
    } catch (err) {
      // One bad row must not lose the other five.
      console.error(`buyer signal persist failed for tweet ${g.tweet.id}`, err);
    }
  }

  stages.surfaced = surfaced;
  stages.backfilled = backfilled;
  return { status: "ok", surfaced, remaining: remainingAfter(cap, used, surfaced), stages };
}

function remainingAfter(cap: number | null, used: number, surfaced: number): number | null {
  return cap === null ? null : Math.max(0, cap - (used + surfaced));
}
