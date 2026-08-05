import PgBoss from "pg-boss";
import { config } from "../config.js";
import { dbConnectionOptions } from "../db/pool.js";

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
  /** Sweep for posts stranded mid-publish and put them back in the queue
   *  (jobs/scheduled-post.ts#reapStuckPublishing). */
  scheduledPostReap: "posts.scheduled-reap",
  // NOTE: `agentTick: "agent.tick"` used to sit here. The single global autopilot
  // it drove was subsumed by the multi-automation system in migration 0024, and
  // nothing has referenced the queue since - no worker, no sender, no schedule -
  // yet startBoss() below kept creating and updating it on every boot. Removed.
  // jobs/workers.ts still unschedules the literal string "agent.tick" so installs
  // that registered the old cron shed it; that list deliberately does not depend
  // on this constant.
  buyerRadar: "buyer.radar",
  buyerRecalibrate: "buyer.recalibrate",
  /** On-demand "Scan now". Separate from the scheduled buyer.radar sweep because
   *  it is user-triggered, per-user, and its result is polled by the web app. */
  buyerScanNow: "buyer.scan-now",
  inspirationSeed: "inspiration.seed",
  automationTick: "automation.tick",
  /** Twice-daily incremental re-pull of every connected X account, so nobody has
   *  to reconnect just to get fresh data (jobs/x-refresh.ts). */
  xRefresh: "x.refresh",
  linkedinRefresh: "linkedin.refresh",
  /** Weekly housekeeping: roll up usage_events and prune the operational tables
   *  so storage stays bounded (jobs/retention.ts). */
  retention: "db.retention",
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
  platform?: "x" | "linkedin";
}

let boss: PgBoss | undefined;

export function getBoss(): PgBoss {
  if (!boss) throw new Error("pg-boss not started");
  return boss;
}

let ensurePromise: Promise<PgBoss> | undefined;

/**
 * Lazily start pg-boss for a process that only ENQUEUES - namely the web app
 * (`packages/web`), which runs domain code in-process but never calls
 * `startBoss()` (that's the backend server's job). Idempotent and
 * concurrency-safe. No-op if already started.
 *
 * THIS USED TO CALL `startBoss()`, and that was expensive in a way nothing made
 * visible. Vercel is serverless, so every cold start that touched chat, connect,
 * scheduling or buyer radar paid for: pg-boss's schema migrate check, its
 * supervision + monitoring timers (in a process that is about to be frozen), and
 * a loop of 27 `createQueue` + 27 `updateQueue` calls - **54 queries to
 * re-declare queues the backend already owns**. All of it billed as Neon compute
 * time, none of it doing anything.
 *
 * Enqueue-only mode instead: no supervision, no cron scheduling, no schema
 * migration, and no queue declarations. The backend's `startBoss()` remains the
 * single writer of queue configuration, which is where that responsibility
 * belonged anyway - two processes racing on `updateQueue` was never intentional.
 */
export async function ensureBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const b = new PgBoss({
        // Shared with db/pool.ts so TLS can't be right in one place and wrong
        // here - a raw DATABASE_URL fails Supabase's cert check outright.
        ...dbConnectionOptions(),
        schema: "pgboss",
        // Nothing here consumes jobs, so none of the background machinery earns
        // its keep. `migrate: false` is safe because the backend, which does run
        // migrations, deploys from the same commit.
        supervise: false,
        schedule: false,
        migrate: false,
        // Enqueue-only, and it runs on Vercel where each serverless instance
        // builds its own pool - so it takes the smallest slice that still works.
        max: 2,
      });
      b.on("error", (err) => console.error("pg-boss error (enqueue-only)", err));
      await b.start();
      boss = b;
      return b;
    })().catch((err) => {
      // Don't cache a rejected promise - a transient DB blip at cold start would
      // otherwise poison every later enqueue in this instance's lifetime.
      ensurePromise = undefined;
      throw err;
    });
  }
  return ensurePromise;
}

/**
 * How often an idle worker asks the database for work.
 *
 * WHY THIS IS SET AT ALL. pg-boss defaults to 2000ms, and `registerWorkers`
 * makes ~33 workers (27 `work()` sites, two of them inside an
 * INGEST_CONCURRENCY=4 loop). At the default that is ~16 queries/second - about
 * 1.4 MILLION "any jobs?" round-trips a day - every one of them almost always
 * returning nothing. Postgres barely notices the load, but Neon bills COMPUTE
 * TIME, and a database questioned 16×/second never gets to suspend. That is what
 * exhausted the compute quota and took production down with PG 53000
 * (`insufficient_resources`) on 2026-07-30: every /app page 500'd because the
 * database had been cut off, not because anything in the app was wrong.
 *
 * 30s is chosen against what the queues actually are: crons, fleet sweeps and
 * ingest fan-out, none of which care about half a minute. The three queues where
 * a human is genuinely waiting get an explicit override - see FAST_POLL_SECONDS
 * and its call sites in workers.ts. Net effect is ~85% fewer idle queries.
 */
export const POLL_SECONDS = 30;

/** For queues where someone is watching a spinner. Keep these responsive. */
export const FAST_POLL_SECONDS = 2;

/** Scheduled posts are `startAfter`-driven, so polling only bounds how LATE one
 *  can be. 15s of drift on a post the user scheduled for 09:00 is invisible. */
export const SCHEDULED_POST_POLL_SECONDS = 15;

/**
 * pg-boss's share of Supabase's 15-connection session-pooler budget (the split is
 * documented on APP_POOL_MAX in db/pool.ts). pg-boss defaults to 10 and declared
 * nothing here, so it took 10 while the app pool took another 10 - 20 against a
 * ceiling of 15, which threw EMAXCONNSESSION and made unrelated queries fail at
 * random. It gets the larger share because 27 registered workers poll plus its
 * maintenance and cron machinery.
 */
const BOSS_POOL_MAX = 8;

export async function startBoss(): Promise<PgBoss> {
  boss = new PgBoss({
    ...dbConnectionOptions(),
    schema: "pgboss",
    pollingIntervalSeconds: POLL_SECONDS,
    max: BOSS_POOL_MAX,
  });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  // Scheduled fleet jobs that hit PAID external providers and re-run on their
  // own cron anyway - retrying a failed run just triples provider spend on a
  // flaky day for data the next tick fetches regardless. No retries for these.
  const NO_RETRY: string[] = [
    QUEUES.trendFetch,
    QUEUES.trendMatch,
    QUEUES.viralBenchmark,
    QUEUES.mentionsFetch,
    QUEUES.peerIngest,
    QUEUES.buyerRadar,
    QUEUES.inspirationSeed,
    QUEUES.xRefresh,
    // User-triggered and paid: a retry would double-spend the provider budget on
    // a scan the user can simply run again.
    QUEUES.buyerScanNow,
  ];
  // A "Scan now" fans out into several composition loops, and under SDK mode each
  // one is a subprocess that may queue behind AGENT_MAX_CONCURRENCY. The default
  // 10-minute expiry can plausibly be hit; expiring mid-scan would strand a job
  // the user is actively polling.
  // x.refresh is a SEQUENTIAL fleet sweep - the provider throttle is 5.5s/request
  // and it walks every connected account, so it budgets up to 45 wall-clock
  // minutes (jobs/x-refresh.ts MAX_RUN_MS). Under the default 10-minute expiry
  // pg-boss would kill it mid-sweep every single tick.
  // posts.scheduled publishes media before it publishes text, and that path can
  // legitimately run for minutes: a 200 MB video is a 120s fetch from Blob, a
  // chunked upload, then a transcode poll that alone budgets 5 minutes. Under the
  // default 10-minute expiry pg-boss would kill such a job AFTER it had claimed
  // the row, stranding the post in 'publishing' with no error and no retry -
  // 20 minutes covers the worst realistic case, and reapStuckPublishing (which
  // waits 30) is the backstop for anything that still dies mid-flight.
  const LONG_EXPIRY: Partial<Record<string, number>> = {
    [QUEUES.buyerScanNow]: 30,
    [QUEUES.xRefresh]: 60,
    [QUEUES.scheduledPost]: 20,
  };
  // `singletonKey` ONLY dedupes on a non-standard policy: pg-boss v10 builds its
  // unique indexes with `WHERE policy = 'short' | 'singleton' | 'stately'`, so on
  // the default `standard` policy a singletonKey is silently ignored. Buyer
  // "Scan now" is user-triggered and spends real twitterapi.io + LLM budget, so
  // two queued scans is money, not just noise - `short` makes the unique index
  // on (name, singletonKey) apply while a job is still `created`. It is only
  // half the guard: it cannot stop a second scan starting once the first is
  // already `active`, which is why enqueueBuyerScan also checks for an in-flight
  // job before sending.
  const POLICY: Partial<Record<string, "short" | "singleton" | "stately">> = {
    [QUEUES.buyerScanNow]: "short",
  };
  for (const q of Object.values(QUEUES)) {
    // Per-item ingest jobs (extract/embed/transcribe/…) DO retry - a retry there
    // recovers real per-capture work that won't otherwise re-run. The scheduled
    // provider jobs above don't: 0 retries, they come back on the next cron.
    const retryLimit = NO_RETRY.includes(q) ? 0 : 3;
    const policy = {
      name: q,
      retryLimit,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: LONG_EXPIRY[q] ?? 10,
      ...(POLICY[q] ? { policy: POLICY[q] } : {}),
    };
    await boss.createQueue(q, policy);
    await boss.updateQueue(q, policy);
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  await boss?.stop();
  boss = undefined;
}
