import PgBoss from "pg-boss";
import { config } from "../config.js";

export const QUEUES = {
  transcribe: "capture.transcribe",
  extract: "capture.extract",
  embedLink: "memory.embed-link",
  surfaceTick: "surface.tick",
  clusterRebuild: "cluster.rebuild",
  voiceRebuild: "voice.rebuild",
  offerAngles: "offer.angles",
  trendFetch: "trend.fetch",
  trendMatch: "trend.match",
  viralBenchmark: "trend.viral",
  ingestProfile: "strategist.ingest",
  diagnose: "strategist.diagnose",
  progressReport: "strategist.progress",
  mentionsFetch: "engagement.mentions",
  peerIngest: "benchmark.peers",
  weeklyPlan: "strategist.weekly-plan",
  performancePulse: "performance.pulse",
  campaignDetect: "memory.campaign-detect",
  classificationRecalibrate: "memory.classification-recalibrate",
  scheduledPost: "posts.scheduled",
  agentTick: "agent.tick",
  buyerRadar: "buyer.radar",
  buyerRecalibrate: "buyer.recalibrate",
  /** On-demand "Scan now". Separate from the scheduled buyer.radar sweep because
   *  it is user-triggered, per-user, and its result is polled by the web app. */
  buyerScanNow: "buyer.scan-now",
  inspirationSeed: "inspiration.seed",
  automationTick: "automation.tick",
} as const;

export interface TranscribeJob {
  captureId: string;
  userId: string;
}
export interface ExtractJob {
  captureId: string;
  userId: string;
}
export interface EmbedLinkJob {
  memoryId: string;
  userId: string;
}
export interface OfferAnglesJob {
  /** When set, offer angles for this specific moment; otherwise pick the best candidate. */
  momentId?: string;
  userId: string;
}
export interface IngestProfileJob {
  accountId: string;
  userId: string;
}
export interface DiagnoseJob {
  userId: string;
  /** How many readiness re-checks have already run (bounds the wait loop). */
  attempt?: number;
  /** Whether the mid-ingestion "still reading" check-in has already fired. */
  pingedSlow?: boolean;
}
export interface CampaignDetectJob {
  captureId: string;
  userId: string;
  /** Bounds the wait for this capture's memory embeddings to finish. */
  attempt?: number;
}
export interface ScheduledPostJob {
  scheduledPostId: string;
  userId: string;
}
export interface BuyerScanNowJob {
  userId: string;
}

let boss: PgBoss | undefined;

export function getBoss(): PgBoss {
  if (!boss) throw new Error("pg-boss not started");
  return boss;
}

let ensurePromise: Promise<PgBoss> | undefined;

/**
 * Lazily start pg-boss so a process that only ENQUEUES jobs can do so — namely
 * the web app (`packages/web`), which runs domain code in-process but never
 * calls `startBoss()` (that's the backend server's job). Idempotent and
 * concurrency-safe; it starts the same engine `startBoss()` does (queues get
 * created), but the caller registers no workers/crons, so nothing here consumes
 * jobs — the backend worker still does that. No-op if already started.
 */
export async function ensureBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!ensurePromise) ensurePromise = startBoss();
  return ensurePromise;
}

export async function startBoss(): Promise<PgBoss> {
  boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss" });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  // Scheduled fleet jobs that hit PAID external providers and re-run on their
  // own cron anyway — retrying a failed run just triples provider spend on a
  // flaky day for data the next tick fetches regardless. No retries for these.
  const NO_RETRY: string[] = [
    QUEUES.trendFetch,
    QUEUES.trendMatch,
    QUEUES.viralBenchmark,
    QUEUES.mentionsFetch,
    QUEUES.peerIngest,
    QUEUES.buyerRadar,
    QUEUES.inspirationSeed,
    // User-triggered and paid: a retry would double-spend the provider budget on
    // a scan the user can simply run again.
    QUEUES.buyerScanNow,
  ];
  // A "Scan now" fans out into several composition loops, and under SDK mode each
  // one is a subprocess that may queue behind AGENT_MAX_CONCURRENCY. The default
  // 10-minute expiry can plausibly be hit; expiring mid-scan would strand a job
  // the user is actively polling.
  const LONG_EXPIRY: Partial<Record<string, number>> = { [QUEUES.buyerScanNow]: 30 };
  for (const q of Object.values(QUEUES)) {
    // Per-item ingest jobs (extract/embed/transcribe/…) DO retry — a retry there
    // recovers real per-capture work that won't otherwise re-run. The scheduled
    // provider jobs above don't: 0 retries, they come back on the next cron.
    const retryLimit = NO_RETRY.includes(q) ? 0 : 3;
    const policy = { name: q, retryLimit, retryDelay: 30, retryBackoff: true, expireInMinutes: LONG_EXPIRY[q] ?? 10 };
    await boss.createQueue(q, policy);
    await boss.updateQueue(q, policy);
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  await boss?.stop();
  boss = undefined;
}
