/**
 * Per-user threshold recalibration for Buyer Radar (§3j feedback loop). The
 * user's verdicts on surfaced signals are the training signal, re-derived into
 * per-user overrides of the global gates — deterministically, not by an LLM
 * (mirrors memory/corrections.ts). The doctrine: code tunes the gates from real
 * feedback; the model never touches selection.
 *
 * - 'not_a_fit' is the highest-signal correction (the domain match was wrong) →
 *   TIGHTEN the niche gate (require a closer match).
 * - 'skipped' (surfaced but not worth acting on) → raise the intent bar.
 * - 'replied' (the signal was good) → relax both back toward the defaults, so a
 *   user whose radar is landing gets MORE, not fewer, candidates.
 */
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";

export interface BuyerThresholds {
  intent: number;
  niche: number;
}
export interface VerdictCounts {
  not_a_fit: number;
  skipped: number;
  replied: number;
}

const INTENT_STEP = 0.03;
const NICHE_STEP = 0.03;
const INTENT_MAX_UP = 0.15;
const INTENT_MAX_DOWN = 0.1;
const NICHE_MAX_TIGHTEN = 0.15;
const INTENT_FLOOR = 0.3;
const INTENT_CEIL = 0.75;
const NICHE_FLOOR = 0.35;
const WINDOW_DAYS = 45;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The global defaults a user's calibration adjusts around. */
export function baseThresholds(): BuyerThresholds {
  return { intent: config.INTENT_THRESHOLD, niche: config.BUYER_NICHE_THRESHOLD };
}

/**
 * Pure: derive per-user thresholds from the recent verdict mix. Deterministic
 * and bounded — recalibration nudges (±0.03/verdict, capped), never swings.
 */
export function buildCalibration(counts: VerdictCounts, base: BuyerThresholds): BuyerThresholds {
  const { not_a_fit: nf, skipped: sk, replied: rep } = counts;

  // Niche gate: not_a_fit means the match was wrong → tighten (lower threshold);
  // replies mean it's landing → let it relax back toward base.
  const nicheNet = clamp(nf - rep, 0, 5);
  const niche = clamp(base.niche - NICHE_STEP * nicheNet, Math.max(NICHE_FLOOR, base.niche - NICHE_MAX_TIGHTEN), base.niche);

  // Intent bar: weak/irrelevant surfacings (skips + not-a-fits) push it up;
  // replies (worth 2x, they're the scarce positive) pull it down.
  const intentNet = sk + nf - 2 * rep;
  let intent = base.intent;
  if (intentNet > 0) intent = base.intent + INTENT_STEP * Math.min(5, intentNet);
  else if (intentNet < 0) intent = base.intent - INTENT_STEP * Math.min(3, -intentNet);
  intent = clamp(intent, Math.max(INTENT_FLOOR, base.intent - INTENT_MAX_DOWN), Math.min(INTENT_CEIL, base.intent + INTENT_MAX_UP));

  return { intent: round3(intent), niche: round3(niche) };
}

/** This user's effective gates: their calibrated overrides, or the config defaults. */
export async function effectiveThresholds(userId: string): Promise<BuyerThresholds> {
  const row = await queryOne<{ intent_threshold: number; niche_threshold: number }>(
    `SELECT intent_threshold, niche_threshold FROM buyer_calibration WHERE user_id = $1`,
    [userId],
  );
  if (!row) return baseThresholds();
  return { intent: row.intent_threshold, niche: row.niche_threshold };
}

async function recentVerdictCounts(userId: string): Promise<VerdictCounts> {
  const row = await queryOne<{ nf: string; sk: string; rep: string }>(
    `SELECT
        count(*) FILTER (WHERE verdict = 'not_a_fit')::text AS nf,
        count(*) FILTER (WHERE verdict = 'skipped')::text AS sk,
        count(*) FILTER (WHERE verdict = 'replied')::text AS rep
     FROM buyer_signals
     WHERE user_id = $1 AND surfaced_at > now() - make_interval(days => $2)`,
    [userId, WINDOW_DAYS],
  );
  return { not_a_fit: Number(row?.nf ?? 0), skipped: Number(row?.sk ?? 0), replied: Number(row?.rep ?? 0) };
}

/** Re-derive and persist one user's thresholds. No-op when they've given no feedback yet. */
export async function recalibrateUser(userId: string): Promise<void> {
  const counts = await recentVerdictCounts(userId);
  if (counts.not_a_fit + counts.skipped + counts.replied === 0) return;
  const t = buildCalibration(counts, baseThresholds());
  await query(
    `INSERT INTO buyer_calibration (user_id, intent_threshold, niche_threshold, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET intent_threshold = $2, niche_threshold = $3, updated_at = now()`,
    [userId, t.intent, t.niche],
  );
}

/** Monthly sweep: recalibrate every user who gave feedback in the window. */
export async function handleBuyerRecalibration(): Promise<void> {
  const users = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM buyer_signals
     WHERE verdict IN ('not_a_fit','skipped','replied') AND surfaced_at > now() - make_interval(days => $1)`,
    [WINDOW_DAYS],
  );
  for (const { user_id } of users) {
    await recalibrateUser(user_id).catch((err) => console.error(`buyer recalibration failed for ${user_id}`, err));
  }
}
