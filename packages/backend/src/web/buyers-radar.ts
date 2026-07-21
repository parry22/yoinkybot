/**
 * Web read-model + actions for Buyer Radar (the web app is the v1 delivery
 * surface). Mirrors web/inspiration.ts: typed views + thin async functions the
 * Next.js routes call. All selection/scoring/gating already happened in the
 * buyer/* engine; this only reads rows and records the user's verdicts.
 */
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { getIcp, saveIcp, prefillIcp, icpComplete, type IcpInput, type IcpPrefill } from "../buyer/icp.js";
import { scanForUser, monthlySurfacedCount, type ScanStatus } from "../buyer/scan.js";
import { recalibrateUser } from "../buyer/calibration.js";
import { assertClean } from "../moderation/filter.js";

export interface BuyerSignalView {
  id: string;
  handle: string;
  name: string | null;
  initials: string;
  content: string;
  url: string | null;
  /** Domain-fit percentage shown as "% match" in the UI. */
  match: number;
  why: string | null;
  draftReply: string | null;
  intentType: string | null;
  verdict: string;
  postedAt: string | null;
}

export interface BuyerRadarStatus {
  enabled: boolean;
  hasIcp: boolean;
  used: number;
  cap: number;
  remaining: number;
}

export interface BuyerIcpView {
  productOneliner: string;
  buyerDescription: string;
  painSignals: string[];
  competitorTerms: string[];
  exclusions: string[];
  /** True once the two load-bearing fields are set (feature can run). */
  complete: boolean;
}

const VALID_VERDICTS = new Set(["surfaced", "replied", "skipped", "not_a_fit"]);

function initialsFor(handle: string, name: string | null): string {
  const src = (name || handle || "").replace(/^@/, "").trim();
  if (!src) return "??";
  const parts = src.split(/[\s_]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : src.slice(0, 2);
  return letters.toUpperCase();
}

function matchPct(nicheSimilarity: number | null, score: number): number {
  const base = nicheSimilarity ?? score;
  return Math.max(0, Math.min(100, Math.round(base * 100)));
}

/** The current radar: surfaced signals awaiting the user's action, strongest first. */
export async function listBuyerSignals(userId: string, limit = 30): Promise<BuyerSignalView[]> {
  const rows = await query<{
    id: string;
    author_handle: string;
    author_name: string | null;
    content: string;
    url: string | null;
    score: number;
    niche_similarity: number | null;
    why: string | null;
    draft_reply: string | null;
    intent_type: string | null;
    verdict: string;
    posted_at: string | null;
  }>(
    `SELECT id, author_handle, author_name, content, url, score, niche_similarity,
            why, draft_reply, intent_type, verdict, posted_at::text
     FROM buyer_signals
     WHERE user_id = $1 AND verdict IN ('surfaced','replied')
     ORDER BY (verdict = 'surfaced') DESC, score DESC, surfaced_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    handle: r.author_handle,
    name: r.author_name,
    initials: initialsFor(r.author_handle, r.author_name),
    content: r.content,
    url: r.url,
    match: matchPct(r.niche_similarity, r.score),
    why: r.why,
    draftReply: r.draft_reply,
    intentType: r.intent_type,
    verdict: r.verdict,
    postedAt: r.posted_at,
  }));
}

export async function buyerRadarStatus(userId: string): Promise<BuyerRadarStatus> {
  const icp = await getIcp(userId);
  const used = await monthlySurfacedCount(userId);
  const cap = config.BUYER_MONTHLY_SIGNAL_CAP;
  return {
    enabled: config.BUYER_RADAR_ENABLED && Boolean(config.TWITTERAPI_IO_KEY),
    hasIcp: icpComplete(icp),
    used,
    cap,
    remaining: Math.max(0, cap - used),
  };
}

export async function getBuyerIcp(userId: string): Promise<BuyerIcpView | null> {
  const icp = await getIcp(userId);
  if (!icp) return null;
  return {
    productOneliner: icp.product_oneliner ?? "",
    buyerDescription: icp.buyer_description ?? "",
    painSignals: icp.pain_signals,
    competitorTerms: icp.competitor_terms,
    exclusions: icp.exclusions,
    complete: icpComplete(icp),
  };
}

/** Suggested defaults from the brand profile, for pre-filling the intake. */
export async function buyerIcpPrefill(userId: string): Promise<IcpPrefill> {
  return prefillIcp(userId);
}

export async function saveBuyerIcp(userId: string, input: IcpInput): Promise<BuyerIcpView> {
  // Content gate on every free-text ICP field (throws ModerationError → 400).
  for (const field of [input.product_oneliner, input.buyer_description]) {
    if (field) assertClean(field);
  }
  for (const list of [input.pain_signals, input.competitor_terms, input.exclusions]) {
    for (const item of list ?? []) assertClean(item);
  }
  const icp = await saveIcp(userId, input);
  return {
    productOneliner: icp.product_oneliner ?? "",
    buyerDescription: icp.buyer_description ?? "",
    painSignals: icp.pain_signals,
    competitorTerms: icp.competitor_terms,
    exclusions: icp.exclusions,
    complete: icpComplete(icp),
  };
}

export interface ScanResponse {
  status: ScanStatus;
  surfaced: number;
  signals: BuyerSignalView[];
}

/** On-demand scan (the "Scan now" button). Budget-gated inside scanForUser. */
export async function scanBuyerSignals(userId: string): Promise<ScanResponse> {
  const result = await scanForUser(userId);
  const signals = await listBuyerSignals(userId);
  return { status: result.status, surfaced: result.surfaced, signals };
}

/**
 * Record the user's action on a signal. 'not_a_fit' is the highest-signal
 * correction (kept for the tuning loop + dedup); 'skipped' dismisses it. Verdict
 * is validated against the allowed set.
 */
export async function setBuyerSignalVerdict(userId: string, id: string, verdict: string): Promise<{ ok: boolean }> {
  if (!VALID_VERDICTS.has(verdict)) return { ok: false };
  const reason = verdict === "not_a_fit" ? "user marked not a fit" : null;
  const row = await queryOne<{ id: string }>(
    `UPDATE buyer_signals SET verdict = $3, verdict_reason = COALESCE($4, verdict_reason)
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId, verdict, reason],
  );
  if (!row) return { ok: false };
  // A corrective verdict recalibrates the user's gates immediately (not_a_fit is
  // the highest-signal correction and tightens the niche gate). Best-effort — a
  // recalibration failure must not fail the verdict write. The monthly sweep
  // (buyer/calibration.ts) is the backstop.
  if (verdict === "not_a_fit" || verdict === "skipped") {
    await recalibrateUser(userId).catch((err) => console.error("inline buyer recalibration failed", err));
  }
  return { ok: true };
}
