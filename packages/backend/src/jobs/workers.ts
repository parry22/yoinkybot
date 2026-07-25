import type PgBoss from "pg-boss";
import { queryOne } from "../db/pool.js";
import {
  QUEUES,
  type EmbedLinkJob,
  type ExtractJob,
  type OfferAnglesJob,
  type TranscribeJob,
} from "./boss.js";
import { handleTranscribe } from "./transcribe.js";
import { handleExtract } from "./extract.js";
import { handleEmbedLink } from "./embed-link.js";
import { handleSurfaceTick } from "./resurface.js";
import { handleClusterRebuild } from "./cluster.js";
import { handleVoiceRebuild } from "../voice/profile.js";
import { maybeOfferAngles } from "./offer-angles.js";
import { alertAdmin } from "../lib/alerts.js";
import { handleTrendFetch } from "./trend-fetch.js";
import { handleTrendMatch } from "./trend-match.js";
import { handleViralBenchmark } from "./viral-benchmark.js";
import { handleBuyerRadar, handleBuyerScanNow } from "./buyer-radar.js";
import { handleBuyerRecalibration } from "../buyer/calibration.js";
import { handleInspirationSeed } from "./inspiration-seed.js";
import { handleIngestProfile } from "../strategist/connect.js";
import { handleDiagnose } from "../strategist/diagnosis.js";
import { handleProgressReport } from "../strategist/progress.js";
import { handleMentionsFetch } from "../engagement/service.js";
import { handlePeerIngest } from "../benchmark/peers.js";
import { handleWeeklyPlan } from "./weekly-plan.js";
import { handlePerformancePulse } from "../strategist/performance.js";
import { handleCampaignDetect } from "./campaign-detect.js";
import { handleMonthlyRecalibration } from "../memory/corrections.js";
import { handleScheduledPost } from "./scheduled-post.js";
import { handleAutomationTick } from "../automations/tick.js";
import type {
  IngestProfileJob,
  DiagnoseJob,
  CampaignDetectJob,
  ScheduledPostJob,
  BuyerScanNowJob,
} from "./boss.js";

/**
 * Log a worker failure with enough context to trace it (queue, job id, payload),
 * then rethrow so pg-boss fails the job and the queue's retry policy applies.
 */
function logged<T>(queue: string, fn: (data: T, jobId: string) => Promise<unknown>) {
  return async (jobs: Array<{ id: string; data: T }>) => {
    const job = jobs[0];
    if (!job) return;
    try {
      // RETURN the handler's value — pg-boss persists it as the job's `output`,
      // which is how buyer.scan-now hands its result back to the web app's poll.
      // Handlers that return void are unaffected (undefined output).
      return await fn(job.data, job.id);
    } catch (err) {
      console.error(`job failed [${queue}] id=${job.id} data=${JSON.stringify(job.data).slice(0, 300)}`, err);
      // Throttled per queue — a crash-looping job pages once an hour, not per retry.
      void alertAdmin(`job:${queue}`, `job failing [${queue}]: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
}

// Extraction is the ingest bottleneck: a 120-post connect is ~120 extract jobs
// + ~150 embed/link jobs, each an LLM/embedding round-trip. Sequential, that's
// 8-10 minutes of "reading"; four independent workers per queue cut it to ~2-3.
// Each registration is its own single-job worker, so one failure never takes a
// batch with it. Tradeoff, accepted: belief reconciliation ordering becomes
// near-chronological (within a 4-job window) instead of strictly chronological.
const INGEST_CONCURRENCY = 4;

export async function registerWorkers(boss: PgBoss): Promise<void> {
  await boss.work<TranscribeJob>(QUEUES.transcribe, logged(QUEUES.transcribe, (d: TranscribeJob) => handleTranscribe(d)));
  for (let i = 0; i < INGEST_CONCURRENCY; i++) {
    await boss.work<ExtractJob>(QUEUES.extract, logged(QUEUES.extract, (d: ExtractJob) => handleExtract(d)));
    await boss.work<EmbedLinkJob>(QUEUES.embedLink, logged(QUEUES.embedLink, (d: EmbedLinkJob) => handleEmbedLink(d)));
  }
  // Every job on this queue is a direct per-moment send (trend match, or an
  // in-chat "turn into angles" tap) — there is no ambient scan anymore, see
  // the retired hourly tick note below.
  await boss.work<OfferAnglesJob>(
    QUEUES.offerAngles,
    logged(QUEUES.offerAngles, (d: OfferAnglesJob) => maybeOfferAngles(d)),
  );
  await boss.work(QUEUES.surfaceTick, logged(QUEUES.surfaceTick, () => handleSurfaceTick()));
  await boss.work(QUEUES.clusterRebuild, logged(QUEUES.clusterRebuild, () => handleClusterRebuild()));
  await boss.work(QUEUES.voiceRebuild, logged(QUEUES.voiceRebuild, () => handleVoiceRebuild()));
  await boss.work(QUEUES.trendFetch, logged(QUEUES.trendFetch, () => handleTrendFetch()));
  await boss.work(QUEUES.trendMatch, logged(QUEUES.trendMatch, () => handleTrendMatch()));
  await boss.work(QUEUES.viralBenchmark, logged(QUEUES.viralBenchmark, () => handleViralBenchmark()));
  await boss.work(QUEUES.buyerRadar, logged(QUEUES.buyerRadar, () => handleBuyerRadar()));
  await boss.work(QUEUES.buyerRecalibrate, logged(QUEUES.buyerRecalibrate, () => handleBuyerRecalibration()));
  // On-demand "Scan now" from the web app. Runs here, not in the Vercel route,
  // because SDK-mode composition spawns subprocesses (§3n).
  await boss.work<BuyerScanNowJob>(
    QUEUES.buyerScanNow,
    logged(QUEUES.buyerScanNow, (d: BuyerScanNowJob) => handleBuyerScanNow(d)),
  );
  await boss.work<{ userId: string }>(
    QUEUES.inspirationSeed,
    logged(QUEUES.inspirationSeed, (d: { userId: string }) => handleInspirationSeed(d.userId)),
  );
  await boss.work<IngestProfileJob>(
    QUEUES.ingestProfile,
    logged(QUEUES.ingestProfile, (d: IngestProfileJob) => handleIngestProfile(d)),
  );
  await boss.work<DiagnoseJob>(QUEUES.diagnose, logged(QUEUES.diagnose, (d: DiagnoseJob) => handleDiagnose(d)));
  await boss.work(QUEUES.progressReport, logged(QUEUES.progressReport, () => handleProgressReport()));
  await boss.work(QUEUES.mentionsFetch, logged(QUEUES.mentionsFetch, () => handleMentionsFetch()));
  await boss.work(QUEUES.peerIngest, logged(QUEUES.peerIngest, () => handlePeerIngest()));
  await boss.work(QUEUES.weeklyPlan, logged(QUEUES.weeklyPlan, () => handleWeeklyPlan()));
  await boss.work(QUEUES.performancePulse, logged(QUEUES.performancePulse, () => handlePerformancePulse()));
  // Concurrency 1, deliberately: campaign detection isn't latency-sensitive
  // (pure background enrichment), and serializing it per-process closes the
  // create-race two sibling captures could otherwise cause — see campaign-detect.ts.
  await boss.work<CampaignDetectJob>(
    QUEUES.campaignDetect,
    logged(QUEUES.campaignDetect, (d: CampaignDetectJob) => handleCampaignDetect(d)),
  );
  await boss.work(
    QUEUES.classificationRecalibrate,
    logged(QUEUES.classificationRecalibrate, () => handleMonthlyRecalibration()),
  );
  // Scheduled posts publish at a user-chosen time — each job is sent with
  // startAfter = that time, so this worker just fires when one comes due. The
  // handler claims the row atomically, so a single worker is enough and can't
  // double-post across a delivery retry.
  await boss.work<ScheduledPostJob>(
    QUEUES.scheduledPost,
    logged(QUEUES.scheduledPost, (d: ScheduledPostJob) => handleScheduledPost(d)),
  );

  // Web "agent mode": once/day, for each user who's opted in, run the full
  // topic→draft→schedule loop. The handler enforces a per-user ~daily gap.
  await boss.work(QUEUES.automationTick, logged(QUEUES.automationTick, () => handleAutomationTick()));

  // Proactive engine tick: hourly; cadence/quiet-hour gates live in the handler.
  // This single tick now also offers to turn the resurfaced idea into angles
  // (see resurface.ts) — the old separate hourly angle-offer sweep scanned for
  // ambient "shareable" moments that nothing has produced since the browser
  // extension was removed, so it's retired rather than left running empty.
  await boss.schedule(QUEUES.surfaceTick, "0 * * * *");
  // Memory map rebuild + voice rebuild: quiet early-morning dailies.
  await boss.schedule(QUEUES.clusterRebuild, "30 3 * * *");
  await boss.schedule(QUEUES.voiceRebuild, "15 4 * * *");
  // Trends: fetch a few times daily; match runs morning/midday/evening IST for
  // the ICP — the handler itself enforces "send at most once a day", so later
  // runs only get a shot when the earlier ones didn't fire.
  await boss.schedule(QUEUES.trendFetch, "0 */8 * * *");
  await boss.schedule(QUEUES.trendMatch, "30 2,7,13 * * *"); // 08:00 / 12:30 / 19:00 IST
  // Daily viral case study: THREE spread ticks, not one. The handler caps at one
  // delivery per user per day and drops (doesn't defer) a user who's in quiet
  // hours right now — so a single fixed tick means a user whose quiet hours cover
  // that instant (e.g. US-evening under a 06:00 UTC tick) would NEVER receive it.
  // Spreading the ticks across the globe's active windows lets a later tick catch
  // whoever the earlier one skipped; the once-a-day gate prevents duplicates and
  // skips the paid search for anyone already delivered today.
  await boss.schedule(QUEUES.viralBenchmark, "0 3,11,19 * * *"); // 08:30/16:30/00:30 IST — global spread
  // Buyer Radar: DARK by default (handleBuyerRadar no-ops unless BUYER_RADAR_PROACTIVE).
  // Modest once-daily cadence when enabled — search is per-user (O(users)) and paid,
  // unlike the shared trend/viral pool. scanForUser enforces the monthly budget.
  await boss.schedule(QUEUES.buyerRadar, "0 6 * * *"); // 11:30 IST daily
  // Buyer Radar recalibration: monthly re-derive of per-user gates from verdicts
  // (the inline not_a_fit/skipped path is the responsive one; this is the backstop).
  await boss.schedule(QUEUES.buyerRecalibrate, "0 7 1 * *");
  // Public mentions ingest (classification + scoring only — the hourly
  // proactive tick decides delivery, replies get priority in that slot).
  await boss.schedule(QUEUES.mentionsFetch, "15 */6 * * *");
  // Peer watchlist ingest: weekly, Sunday night — Monday's progress report
  // folds the comparison in. Peers are compared over time, never tracked live.
  await boss.schedule(QUEUES.peerIngest, "0 20 * * 0");
  // Strategist progress read: weekly (handler enforces the 2-4 week per-user gap).
  await boss.schedule(QUEUES.progressReport, "0 5 * * 1"); // Mondays 10:30 IST
  // The week-opening working note: right after the progress read on Mondays.
  await boss.schedule(QUEUES.weeklyPlan, "30 5 * * 1"); // Mondays 11:00 IST
  // Next-day performance pulse: daily, before the morning window.
  await boss.schedule(QUEUES.performancePulse, "45 4 * * *"); // 10:15 IST
  // Classification calibration: monthly, 1st of the month — correction-only
  // (see memory/corrections.ts), no external research integration.
  await boss.schedule(QUEUES.classificationRecalibrate, "0 6 1 * *");
  // Automations: fire a few times a day; the handler runs only enabled + due
  // automations (per-day gate + atomic run claims), so it's safe to over-fire.
  await boss.schedule(QUEUES.automationTick, "0 */3 * * *");

  // Retired schedules — pg-boss persists these in its own table independent of
  // the code, so removing a boss.schedule() call above does nothing on an
  // install that already registered it. Drop them explicitly.
  for (const retired of ["macro.match", QUEUES.offerAngles, "agent.tick"]) {
    try {
      await boss.unschedule(retired);
    } catch {
      // never scheduled on this install — fine
    }
  }

  await nudgeStaleTrendJobs(boss);
}

/**
 * On a host that spins the process down when idle (the old Render free tier),
 * a missed cron minute is just gone — pg-boss's schedule() doesn't backfill it,
 * it only fires while the process happens to be alive at the right time. This
 * bit hard in production (2026-07-12): trend.fetch crashed once on 2026-07-08,
 * and with the app redeploying/restarting far more often than its 8h interval
 * since, it never got another aligned window — the trends table sat empty for
 * 4 days with zero user-visible symptom until someone noticed no trend offers
 * ever fired.
 *
 * Rather than chase host reliability, make boot itself a chance to catch up:
 * every process start also tries trendFetch/trendMatch once, in addition to
 * the cron. Both are safe to over-fire — trendMatch's handler already caps at
 * one send/day per user internally, and trendFetch dedupes by external_id — so
 * this only ever adds a guaranteed floor ("at least once per process
 * lifetime"), never a duplicate side effect. trendFetch is additionally gated
 * on staleness so a burst of redeploys in one dev session doesn't re-spend on
 * Apify/embeddings every single restart.
 */
async function nudgeStaleTrendJobs(boss: PgBoss): Promise<void> {
  const STALE_AFTER_MS = 7 * 60 * 60 * 1000; // just under the 8h cron interval
  const row = await queryOne<{ last: string | null }>(`SELECT max(fetched_at)::text AS last FROM trends`);
  const staleOrNever = !row?.last || Date.now() - new Date(row.last).getTime() > STALE_AFTER_MS;
  if (staleOrNever) await boss.send(QUEUES.trendFetch, {});
  await boss.send(QUEUES.trendMatch, {});
}
