import { query } from "../db/pool.js";

export interface UsageEvent {
  userId: string | null;
  eventType: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  cost: number;
}

export async function recordUsage(e: UsageEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO usage_events (user_id, event_type, tokens_in, tokens_out, model, cost)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.userId, e.eventType, e.tokensIn, e.tokensOut, e.model, e.cost],
    );
  } catch (err) {
    // Metering must never take down the request path.
    console.error("usage metering failed", err);
  }
}

export async function usageSummary(userId: string, days = 30) {
  return query<{ event_type: string; model: string; tokens_in: string; tokens_out: string; cost: string }>(
    `SELECT event_type, model,
            sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cost) AS cost
     FROM usage_events
     WHERE user_id = $1 AND at > now() - make_interval(days => $2)
     GROUP BY event_type, model
     ORDER BY cost DESC`,
    [userId, days],
  );
}
