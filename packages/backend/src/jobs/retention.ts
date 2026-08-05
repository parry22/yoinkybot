import { query, queryOne } from "../db/pool.js";

/**
 * Weekly housekeeping: keep the operational tables from growing without bound.
 *
 * WHY THIS EXISTS. Nothing here ever had a retention policy, and the assumption
 * that "storage is cheap" held right up until the database became the binding
 * constraint. `usage_events` is the worst of them - a row per LLM call and per
 * embedding batch, forever, on a table that `underDailyCap` (llm/gateway.ts)
 * reads on the hot path of every single model call. Fastest-growing and
 * hottest-read at once.
 *
 * WHAT IT DOES NOT TOUCH, deliberately: captures, memories, positions,
 * surfacings, mentions, buyer_signals, drafts, angles. That is the user's own
 * content and the product's dedup/history reads it - deleting any of it is a
 * product decision, not housekeeping, and it is not this job's business.
 *
 * pg-boss manages its own archive/delete for completed jobs, so the `pgboss`
 * schema is left alone too.
 */

/**
 * How long raw per-call usage rows stay queryable. 35 days covers the current
 * billing month plus the previous one, which is what any "what did this user
 * actually cost me" question needs, and comfortably exceeds the daily cap's
 * one-day window.
 */
const USAGE_RAW_DAYS = 35;

/** Dedupe rows only need to outlive the provider's retry window. Dodo gives up
 *  in hours; 30 days is already paranoid. */
const WEBHOOK_DEDUPE_DAYS = 30;

/** A rate-limit window is minutes long. A row older than this is dead weight. */
const RATE_LIMIT_DAYS = 7;

export interface RetentionResult {
  rolledUp: number;
  usageDeleted: number;
  webhooksDeleted: number;
  rateLimitsDeleted: number;
}

export async function handleRetention(): Promise<RetentionResult> {
  // ── usage_events → usage_daily ────────────────────────────────────────────
  // Aggregate first, then delete only what was aggregated. Both statements use
  // the same cutoff expression, and the INSERT runs before the DELETE, so a
  // crash between them loses nothing: the next run re-aggregates the same rows
  // and ON CONFLICT makes that idempotent.
  //
  // GREATEST(...) on conflict rather than `+`: if a previous run inserted the
  // rollup but died before its delete, adding again would double-count. Taking
  // the larger value converges to the true total either way, because each run
  // aggregates the FULL remaining set for that day, not a delta.
  const rollup = await query<{ n: string }>(
    `WITH agg AS (
       SELECT user_id, at::date AS day, event_type, model,
              count(*)::int AS calls,
              sum(tokens_in)::bigint AS tokens_in,
              sum(tokens_out)::bigint AS tokens_out,
              sum(cost) AS cost
         FROM usage_events
        WHERE at < now() - ($1 || ' days')::interval
        GROUP BY user_id, at::date, event_type, model
     )
     INSERT INTO usage_daily (user_id, day, event_type, model, calls, tokens_in, tokens_out, cost)
     SELECT user_id, day, event_type, model, calls, tokens_in, tokens_out, cost FROM agg
     ON CONFLICT (user_id, day, event_type, model) DO UPDATE
       SET calls      = GREATEST(usage_daily.calls, EXCLUDED.calls),
           tokens_in  = GREATEST(usage_daily.tokens_in, EXCLUDED.tokens_in),
           tokens_out = GREATEST(usage_daily.tokens_out, EXCLUDED.tokens_out),
           cost       = GREATEST(usage_daily.cost, EXCLUDED.cost)
     RETURNING 1 AS n`,
    [String(USAGE_RAW_DAYS)],
  );

  const usageDel = await query<{ n: string }>(
    `DELETE FROM usage_events
      WHERE at < now() - ($1 || ' days')::interval
      RETURNING 1 AS n`,
    [String(USAGE_RAW_DAYS)],
  );

  const webhookDel = await query<{ n: string }>(
    `DELETE FROM billing_webhook_events
      WHERE received_at < now() - ($1 || ' days')::interval
      RETURNING 1 AS n`,
    [String(WEBHOOK_DEDUPE_DAYS)],
  );

  const rateDel = await query<{ n: string }>(
    `DELETE FROM rate_limits
      WHERE window_start < now() - ($1 || ' days')::interval
      RETURNING 1 AS n`,
    [String(RATE_LIMIT_DAYS)],
  );

  const result: RetentionResult = {
    rolledUp: rollup.length,
    usageDeleted: usageDel.length,
    webhooksDeleted: webhookDel.length,
    rateLimitsDeleted: rateDel.length,
  };

  console.log(
    `[retention] rolled up ${result.rolledUp} usage_daily rows, deleted ` +
      `${result.usageDeleted} usage_events / ${result.webhooksDeleted} webhook / ` +
      `${result.rateLimitsDeleted} rate_limit rows`,
  );

  // Storage only actually returns to the OS on VACUUM, and autovacuum may not
  // get to a table this bursty for a while. On a hosted plan with a hard storage
  // ceiling that lag is the difference between "pruned" and "still over quota".
  // Not VACUUM FULL - that takes an ACCESS EXCLUSIVE lock and rewrites the table.
  if (result.usageDeleted > 0) {
    await query(`VACUUM (ANALYZE) usage_events`).catch((err) =>
      console.error("[retention] vacuum failed (non-fatal)", err),
    );
  }

  return result;
}

/** Rough current size of the tables this job governs - logged so storage
 *  pressure is visible before it becomes an outage rather than after. */
export async function logStorageFootprint(): Promise<void> {
  const row = await queryOne<{ total: string; usage: string }>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS total,
            pg_size_pretty(pg_total_relation_size('usage_events'))  AS usage`,
  ).catch(() => undefined);
  if (row) console.log(`[retention] database ${row.total}, usage_events ${row.usage}`);
}
