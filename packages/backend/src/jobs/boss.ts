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
  ingestProfile: "strategist.ingest",
  diagnose: "strategist.diagnose",
  progressReport: "strategist.progress",
  mentionsFetch: "engagement.mentions",
  peerIngest: "benchmark.peers",
  weeklyPlan: "strategist.weekly-plan",
  performancePulse: "performance.pulse",
  campaignDetect: "memory.campaign-detect",
  classificationRecalibrate: "memory.classification-recalibrate",
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

let boss: PgBoss | undefined;

export function getBoss(): PgBoss {
  if (!boss) throw new Error("pg-boss not started");
  return boss;
}

export async function startBoss(): Promise<PgBoss> {
  boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss" });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  for (const q of Object.values(QUEUES)) {
    // Transient LLM/Apify failures must not silently kill a job mid-ingest:
    // 3 retries with exponential backoff, 10 min per-attempt cap. updateQueue
    // keeps existing queues in sync when this policy changes across deploys.
    const policy = { name: q, retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInMinutes: 10 };
    await boss.createQueue(q, policy);
    await boss.updateQueue(q, policy);
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  await boss?.stop();
  boss = undefined;
}
