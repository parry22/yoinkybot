import type PgBoss from "pg-boss";
import { query, queryOne } from "../db/pool.js";
import { isPaidOrExempt } from "../billing/entitlements.js";
import { QUEUES } from "./boss.js";
import { refreshXEngagement } from "../strategist/performance.js";
import { runAsUser } from "../byok/context.js";

/**
 * Twice-daily automatic X refresh for every connected account.
 *
 * THE GAP THIS CLOSES. Reading a user's X was, until now, something that only
 * happened when they *asked* for it. `/connect` and the Settings "Reconnect X"
 * button both run the full destructive ingest (wipe the corpus, re-pull, re-run
 * the diagnosis); the only incremental path was the daily performance pulse,
 * which is gated on `telegram_id IS NOT NULL` **and** an active brand plan. A
 * web-only user therefore had analytics, follower count and voice signal frozen
 * at their connect-day snapshot forever, and the product's own answer was to
 * reconnect - asking someone to rebuild their whole profile to update a number.
 *
 * WHY THIS IS SAFE TO DO UNPROMPTED. Reads never use the user's OAuth token:
 * every X pull goes through the fleet-wide twitterapi.io key with the public
 * handle as the only per-user input (capture/imports/twitterapi-io.ts). So this
 * can't be broken by an expired user token, and it needs no consent beyond the
 * account already being connected. `refreshXEngagement` is additive - it updates
 * metrics on posts we hold and inserts genuinely new ones - so unlike the full
 * ingest it can never destroy anything.
 *
 * THE THREE GUARDS, and why each exists:
 *
 * 1. SEQUENTIAL, PLUS AN EXPLICIT INTER-USER PAUSE. `MIN_REQUEST_INTERVAL_MS`
 *    (5.5s) in twitterapi-io.ts is enforced by `lastRequestAt`, which is a
 *    variable local to each `fetchTweets` *call* - so it spaces the pages within
 *    one user's pull and nothing else. Going sequential is necessary but not
 *    sufficient: the next user's first page would fire the instant the previous
 *    user's DB writes finish, under the provider's floor, and eat a 429. Hence
 *    PAUSE_BETWEEN_USERS_MS.
 *
 * 2. ATTEMPT-BASED STALENESS GATE. The query keys on `last_refresh_attempt_at`,
 *    stamped whatever the outcome, NOT on `last_refreshed_at`, which only marks
 *    success. Keying on success would let a permanently-broken handle sit at
 *    NULL forever and re-run at the front of every sweep for eternity (see the
 *    migration comment). Redeploys also hit the boot nudge, and Railway restarts
 *    often - without this a busy afternoon of deploys re-spends the budget on
 *    every restart.
 *
 * 3. ENTITLEMENT GATE ON THE EXPENSIVE HALF ONLY. `refreshXEngagement` does two
 *    different things: it UPDATEs metrics on posts we already hold (a plain SQL
 *    write, effectively free, and the reason this job exists), and it ingests
 *    genuinely new posts by fanning them out into QUEUES.extract - one LLM call
 *    per post. `extract` is in CAP_EXEMPT_EVENTS (llm/gateway.ts), so those calls
 *    do not even count against the user's daily budget. Left ungated, this
 *    twice-daily sweep would hand every lapsed free account unmetered LLM
 *    extraction forever, for as long as they kept posting on X. So: metrics for
 *    everyone, extraction only for users with an active entitlement.
 *
 * 4. TIME BUDGET. ~28s per user (3 pages + the pause) means the sweep is
 *    O(users) in wall-clock with no natural ceiling. It stops at MAX_RUN_MS and
 *    logs exactly how many accounts it did not reach - least-recently-attempted
 *    first, so the ones it skips are the ones the next tick picks up. A silent
 *    truncation here would read as "everyone is fresh" when half the fleet is not.
 */

/** Guard 3: does this user get the LLM-backed half of the refresh, or metrics only? */
async function mayIngestNewPosts(userId: string, telegramId: string | null): Promise<boolean> {
  try {
    return isPaidOrExempt({ id: userId, telegram_id: telegramId });
  } catch (err) {
    // Fail CLOSED. A billing lookup that errors must not become a free pass to
    // unmetered extraction; metrics still refresh, which is the job's core value.
    console.error(`[x.refresh] entitlement check failed for ${userId} - metrics only`, err);
    return false;
  }
}

/** Posts pulled per user. Lower than the 100-post ingest: this runs twice a day,
 *  so the recent window is all that can have changed, and each page is ~5.5s. */
const REFRESH_POSTS = 60;

/** Don't re-attempt an account touched more recently than this. Comfortably
 *  below the 12h cron gap so a slightly-late tick still does its work. */
const MIN_AGE_HOURS = 10;

/** Wall-clock ceiling for one sweep. */
const MAX_RUN_MS = 45 * 60 * 1000;

/** The provider floor is 5.5s and its in-call throttle doesn't span callers, so
 *  hold it ourselves between users (guard 1). */
const PAUSE_BETWEEN_USERS_MS = 6000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RefreshTarget {
  user_id: string;
  handle: string;
  telegram_id: string | null;
}

export async function handleXRefresh(): Promise<void> {
  // Every ingested X account, oldest refresh first. Deliberately NOT filtered by
  // telegram_id or plan: the whole point is that web-only users get fresh data.
  const targets = await query<RefreshTarget>(
    `SELECT ca.user_id, ca.handle, u.telegram_id
       FROM connected_accounts ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.platform = 'x'
        AND ca.status = 'ingested'
        AND (ca.last_refresh_attempt_at IS NULL
             OR ca.last_refresh_attempt_at < now() - make_interval(hours => $1::int))
      -- Tiebreak on id: without it the NULL rows come back in planner order,
      -- which can be unstable between runs, so a truncated sweep could keep
      -- picking the same subset and starve the rest.
      ORDER BY ca.last_refresh_attempt_at ASC NULLS FIRST, ca.id ASC`,
    [MIN_AGE_HOURS],
  );

  if (targets.length === 0) {
    console.log("[x.refresh] nothing stale enough to refresh");
    return;
  }

  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  let done = 0;
  let metricsOnly = 0;

  for (const t of targets) {
    if (Date.now() - startedAt > MAX_RUN_MS) {
      // Loud on purpose - see guard 3.
      console.warn(
        `[x.refresh] time budget reached after ${done}/${targets.length} accounts; ` +
          `${targets.length - done} not refreshed this tick (they sort first next time)`,
      );
      break;
    }
    if (done > 0) await sleep(PAUSE_BETWEEN_USERS_MS);
    done++;
    try {
      const ingestNew = await mayIngestNewPosts(t.user_id, t.telegram_id);
      if (!ingestNew) metricsOnly++;
      // The refresh is per user, so it must resolve that user's BYOK key rather
      // than use the fleet key merely because this is a cron job.
      const res = await runAsUser(t.user_id, () => refreshXEngagement(t.user_id, REFRESH_POSTS, { ingestNew }));
      if (res.status === "ok") ok++;
      else if (res.status === "failed") failed++;
    } catch (err) {
      // One bad handle (renamed, suspended, went private) must not end the sweep.
      failed++;
      console.error(`[x.refresh] failed for ${t.handle} (${t.user_id})`, err);
    } finally {
      // Stamped on EVERY outcome - this is what stops a permanently-broken
      // account from re-running at the head of every sweep forever (guard 2).
      // Deliberately separate from refreshXEngagement's own success-only write
      // to last_refreshed_at, and best-effort: a failure to record the attempt
      // must not abort the sweep.
      await query(
        `UPDATE connected_accounts SET last_refresh_attempt_at = now()
          WHERE user_id = $1 AND platform = 'x'`,
        [t.user_id],
      ).catch((err) => console.error(`[x.refresh] could not stamp attempt for ${t.user_id}`, err));
    }
  }

  console.log(
    `[x.refresh] refreshed ${ok}/${done} accounts (${failed} failed, ${metricsOnly} metrics-only - no active plan) ` +
      `in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

/**
 * Boot-time catch-up, mirroring nudgeStaleTrendJobs (workers.ts). pg-boss cron
 * does not backfill a missed window, and this process restarts far more often
 * than twice a day, so a redeploy landing on the wrong side of the schedule
 * could otherwise leave the fleet unrefreshed indefinitely. The staleness gate
 * inside the handler is what makes over-firing free.
 */
export async function nudgeStaleXRefresh(boss: PgBoss): Promise<void> {
  const row = await queryOne<{ stale: string }>(
    `SELECT count(*)::text AS stale
       FROM connected_accounts
      WHERE platform = 'x' AND status = 'ingested'
        AND (last_refresh_attempt_at IS NULL
             OR last_refresh_attempt_at < now() - make_interval(hours => $1::int))`,
    [MIN_AGE_HOURS],
  );
  if (Number(row?.stale ?? 0) > 0) await boss.send(QUEUES.xRefresh, {});
}
