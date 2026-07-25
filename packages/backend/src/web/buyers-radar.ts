/**
 * Web read-model + actions for Buyer Radar (the web app is the v1 delivery
 * surface). Mirrors web/inspiration.ts: typed views + thin async functions the
 * Next.js routes call. All selection/scoring/gating already happened in the
 * buyer/* engine; this only reads rows and records the user's verdicts.
 */
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { entitlementsFor, remainingFor } from "../billing/entitlements.js";
import { getIcp, saveIcp, prefillIcp, icpComplete, type IcpInput, type IcpPrefill } from "../buyer/icp.js";
import { scanForUser, monthlySurfacedCount, type ScanStatus, type ScanResult } from "../buyer/scan.js";
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
  /** null = unlimited (Scale). */
  cap: number | null;
  /** null = unlimited. */
  remaining: number | null;
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
  const cap = (await entitlementsFor(userId)).buyerIntentsPerMonth; // number | null (Scale = null)
  return {
    enabled: config.BUYER_RADAR_ENABLED && Boolean(config.TWITTERAPI_IO_KEY),
    hasIcp: icpComplete(icp),
    used,
    cap,
    remaining: remainingFor(used, cap),
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
  /** Why a scan came back empty, in the user's language. Null when it surfaced something. */
  reason: string | null;
}

/**
 * Turn the funnel counts into one honest sentence. An empty radar has several
 * very different causes (nobody was talking, everybody was off-domain, the model
 * declined them all) and they need different things from the user — so we say
 * which one it was rather than the same "no signals yet" every time.
 */
function emptyReason(result: ScanResult): string | null {
  if (result.surfaced > 0) return null;
  const s = result.stages;
  if (result.status === "budget_exhausted") return "You've hit this month's signal cap.";
  if (result.status === "no_icp") return "Tell me what you sell and who buys it first.";
  if (result.status === "unavailable") return "The X data source isn't connected yet, so there's nothing to scan.";
  if (!s.hasIcpVector) {
    return "Your targeting hasn't been indexed yet — open Edit targeting and save it once to fix this.";
  }
  if (s.candidates === 0) {
    return "Nobody on X matched your category this round. If that keeps happening, widen what you sell in Edit targeting — a broad category finds more than a precise one.";
  }
  if (s.intentPassed === 0) {
    return "People are talking in your category, but nobody was actually asking for anything. That's a quiet week, not a problem.";
  }
  if (s.nichePassed === 0) {
    return `People were asking for things, but none close enough to what you sell. Sharpening "who buys it" in Edit targeting helps here.`;
  }
  if (s.composeFailed > 0 && s.composeFailed === s.composed) {
    return "Found candidates but couldn't draft replies for them — that's on my side, they'll still be here next scan.";
  }
  return "No real buyers this round. Yoinky will keep looking.";
}

/**
 * The scan itself. Called by the pg-boss worker on the BACKEND, never from a
 * Vercel route — see `enqueueBuyerScan` for why.
 */
export async function scanBuyerSignals(userId: string): Promise<ScanResponse> {
  const result = await scanForUser(userId);
  const signals = await listBuyerSignals(userId);
  // The funnel counts are the thing you need when a user says "it found nobody".
  console.log(`buyer scan user=${userId} status=${result.status} surfaced=${result.surfaced}`, result.stages);
  return { status: result.status, surfaced: result.surfaced, signals, reason: emptyReason(result) };
}

export type BuyerScanJobState = "queued" | "running" | "done" | "failed" | "unknown";

export interface BuyerScanTicket {
  jobId: string;
}

export interface BuyerScanProgress {
  state: BuyerScanJobState;
  /** Present only when state === "done". */
  result: ScanResponse | null;
  /** Present only when state === "failed". */
  error: string | null;
}

/**
 * Enqueue an on-demand scan and hand back a ticket to poll (docs/INTERNAL §3n).
 *
 * WHY NOT SYNCHRONOUS ANY MORE: with `AGENT_RUNTIME_BUYER=sdk`, composing an
 * outreach reply spawns a Claude Code subprocess that needs a real filesystem —
 * something a Vercel serverless function does not have, so the old in-request
 * scan simply cannot run in SDK mode. Moving it to pg-boss also retires a problem
 * the synchronous version always had: several paid searches plus a handful of
 * composition loops racing a 300s function ceiling.
 *
 * The web app runs domain code in-process but never starts pg-boss, so
 * `ensureBoss()` lazily starts the engine in enqueue-only mode (it registers no
 * workers — the backend still consumes).
 */
export async function enqueueBuyerScan(userId: string): Promise<BuyerScanTicket> {
  const { ensureBoss, QUEUES } = await import("../jobs/boss.js");
  const boss = await ensureBoss();

  // Re-attach to an in-flight scan rather than starting a second one. This is
  // the PRIMARY duplicate guard, not a nicety: a scan spends real twitterapi.io
  // + LLM budget and burns the user's monthly signal cap, so an impatient second
  // click must not buy a second scan. It also covers the case pg-boss cannot —
  // `short` policy's unique index only applies while a job is still `created`,
  // so once the first scan goes `active` only this check stops a duplicate.
  const inFlight = await findActiveBuyerScan(userId);
  if (inFlight) return { jobId: inFlight };

  const jobId = await boss.send(
    QUEUES.buyerScanNow,
    { userId },
    // Dedupes concurrent clicks atomically, which the check above cannot: two
    // simultaneous requests can both pass it, but only one row survives the
    // unique index. Requires the `short` queue policy set in boss.ts — on the
    // default `standard` policy pg-boss ignores singletonKey entirely.
    { singletonKey: `buyer-scan:${userId}`, retryLimit: 0 },
  );
  if (!jobId) {
    // Lost the race on the unique index — the winner is the scan to report.
    const existing = await findActiveBuyerScan(userId);
    if (existing) return { jobId: existing };
    throw new Error("could not enqueue buyer scan");
  }
  return { jobId };
}

/** The in-flight scan for this user, if any — used to recover a dropped ticket. */
async function findActiveBuyerScan(userId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id::text FROM pgboss.job
     WHERE name = 'buyer.scan-now' AND state IN ('created','active','retry')
       AND data->>'userId' = $1
     ORDER BY created_on DESC LIMIT 1`,
    [userId],
  );
  return row?.id ?? null;
}

/**
 * Poll a scan. Ownership is verified against the job payload so one user cannot
 * read another's scan by guessing a job id.
 */
export async function buyerScanProgress(userId: string, jobId: string): Promise<BuyerScanProgress> {
  const { ensureBoss, QUEUES } = await import("../jobs/boss.js");
  const boss = await ensureBoss();
  // includeArchive: a fast scan can complete and be archived before the first poll.
  const job = await boss.getJobById<BuyerScanNowPayload>(QUEUES.buyerScanNow, jobId, { includeArchive: true });
  if (!job) return { state: "unknown", result: null, error: null };
  if (job.data?.userId !== userId) return { state: "unknown", result: null, error: null };

  switch (job.state) {
    case "created":
    case "retry":
      return { state: "queued", result: null, error: null };
    case "active":
      return { state: "running", result: null, error: null };
    case "completed":
      return { state: "done", result: (job.output as ScanResponse | null) ?? null, error: null };
    case "failed":
    case "cancelled":
      // pg-boss folds expiry into `failed`, so there is no separate case here.
      return {
        state: "failed",
        result: null,
        error: extractJobError(job.output) ?? `scan ${job.state}`,
      };
    default:
      return { state: "unknown", result: null, error: null };
  }
}

interface BuyerScanNowPayload {
  userId: string;
}

/** pg-boss stores a thrown error as `{ message, stack, ... }` on output. */
function extractJobError(output: unknown): string | null {
  if (output && typeof output === "object" && "message" in output) {
    const m = (output as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return null;
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
