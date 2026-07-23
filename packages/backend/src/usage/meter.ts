import { query } from "../db/pool.js";

export interface UsageEvent {
  userId: string | null;
  eventType: string;
  tokensIn: number;
  tokensOut: number;
  /** Subset of tokensIn served from the prompt cache (~4x cheaper). Undefined =
   *  unknown for this transport (recorded as NULL, not 0 — 0 would claim a cold cache). */
  cachedInputTokens?: number;
  model: string;
  cost: number;
  /** The reasoning_effort the call was sent with ("low" | "high" | ...), for cost attribution. */
  reasoningEffort?: string;
}

export async function recordUsage(e: UsageEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO usage_events (user_id, event_type, tokens_in, tokens_out, cached_input_tokens, model, cost, reasoning_effort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.userId, e.eventType, e.tokensIn, e.tokensOut, e.cachedInputTokens ?? null, e.model, e.cost, e.reasoningEffort ?? null],
    );
  } catch (err) {
    // Metering must never take down the request path.
    console.error("usage metering failed", err);
  }
}

export async function usageSummary(userId: string, days = 30) {
  return query<{
    event_type: string;
    model: string;
    tokens_in: string;
    tokens_out: string;
    cached_input_tokens: string | null;
    cost: string;
    cache_hit_rate: string | null;
  }>(
    `SELECT event_type, model,
            sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out,
            sum(cached_input_tokens) AS cached_input_tokens, sum(cost) AS cost,
            -- primary success metric for the cache work: cached ÷ total input.
            -- NULL when no row carried a cached count (unknown, not "0% hit").
            CASE WHEN sum(cached_input_tokens) IS NULL OR sum(tokens_in) = 0 THEN NULL
                 ELSE round(sum(cached_input_tokens)::numeric / sum(tokens_in), 4) END AS cache_hit_rate
     FROM usage_events
     WHERE user_id = $1 AND at > now() - make_interval(days => $2)
     GROUP BY event_type, model
     ORDER BY cost DESC`,
    [userId, days],
  );
}
