import { query, queryOne } from "../db/pool.js";

/**
 * Read models for the web "Inspiration" page (Trends & Virals tabs) - surfaces
 * what the proactive trend-take and daily viral-case-study jobs already
 * delivered to Telegram, from the `surfacings` ledger. Read-only; delivery
 * itself is unchanged (jobs/trend-match.ts, jobs/viral-benchmark.ts).
 */
export interface TrendInspiration {
  id: string;
  deliveredAt: string;
  topic: string;
  summary: string;
  angle: string;
  sourceUrl: string | null;
  sourceNote: string | null;
  buzz: number | null;
  reaction: string | null;
}

export interface ViralInspiration {
  id: string;
  deliveredAt: string;
  author: string;
  viewCount: number;
  breakoutRatio: number | null;
  sourceUrl: string | null;
  sourceNote: string | null;
  reaction: string | null;
}

interface TrendPayload {
  angle?: string;
  buzz?: number;
  source_url?: string | null;
  source_note?: string | null;
  trend_id?: string;
}

export async function listTrendInspiration(userId: string, limit = 20): Promise<TrendInspiration[]> {
  const rows = await query<{
    id: string;
    delivered_at: string;
    user_reaction: string | null;
    payload: TrendPayload;
    topic: string | null;
    summary: string | null;
  }>(
    `SELECT s.id, s.delivered_at::text, s.user_reaction, s.payload, t.topic, t.summary
     FROM surfacings s
     LEFT JOIN trends t ON t.id = (s.payload->>'trend_id')::uuid
     WHERE s.user_id = $1 AND s.type = 'trend_take'
     ORDER BY s.delivered_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    deliveredAt: r.delivered_at,
    topic: r.topic ?? "trend",
    summary: r.summary ?? "",
    angle: r.payload?.angle ?? "",
    sourceUrl: r.payload?.source_url ?? null,
    sourceNote: r.payload?.source_note ?? null,
    buzz: typeof r.payload?.buzz === "number" ? r.payload.buzz : null,
    reaction: r.user_reaction,
  }));
}

/**
 * On-demand fill for the web Inspiration page. When the user's feed is empty or
 * stale, run the same seed pipeline the post-diagnosis job uses (trends match +
 * viral pool, persisted with channel 'web'). Stale-guarded so page loads can't
 * spam paid search.
 *
 * THE GUARD KEYS ON ATTEMPT, NOT SUCCESS. It used to read
 * `max(delivered_at) FROM surfacings` - a timestamp that only exists once the
 * pipeline actually delivered something. A user whose niche matches no trend and
 * whose viral pool comes back empty writes no surfacing at all, so the guard read
 * NULL forever and the billed twitterapi.io search re-ran on EVERY page load. The
 * accounts that got nothing out of it were the ones paying for it most often.
 *
 * `users.inspiration_refresh_attempt_at` is stamped before the pipeline runs and
 * regardless of what it finds - the same reasoning as
 * `connected_accounts.last_refresh_attempt_at` in jobs/x-refresh.ts (migration
 * 0030), where keying on success left a permanently-barren account at the head of
 * every sweep for eternity. Stamped BEFORE rather than after so a pipeline that
 * throws still consumes the window; a crash loop must not become a spend loop.
 */
export async function refreshInspirationForWeb(
  userId: string,
  minAgeHours = 6,
): Promise<{ ran: boolean; queued?: boolean }> {
  // Claim the window atomically: the UPDATE only matches when the last attempt is
  // old enough, so two concurrent page loads can't both pass the check and run
  // the paid search twice.
  const claimed = await queryOne<{ id: string }>(
    `UPDATE users SET inspiration_refresh_attempt_at = now()
      WHERE id = $1
        AND (inspiration_refresh_attempt_at IS NULL
             OR inspiration_refresh_attempt_at < now() - make_interval(hours => $2::int))
      RETURNING id`,
    [userId, minAgeHours],
  );
  if (!claimed) return { ran: false };

  // Enqueue the existing pg-boss worker instead of seeding in the web request
  // (keeps Vercel functions short and shares the diagnosis-path pipeline).
  const { ensureBoss, QUEUES } = await import("../jobs/boss.js");
  const boss = await ensureBoss();
  await boss.send(QUEUES.inspirationSeed, { userId });
  return { ran: true, queued: true };
}

interface ViralPayload {
  author?: string;
  view_count?: number;
  breakout_ratio?: number;
  source_url?: string | null;
  source_note?: string | null;
}

export async function listViralInspiration(userId: string, limit = 20): Promise<ViralInspiration[]> {
  const rows = await query<{ id: string; delivered_at: string; payload: ViralPayload }>(
    `SELECT id, delivered_at::text, payload FROM surfacings
     WHERE user_id = $1 AND type = 'viral_benchmark'
     ORDER BY delivered_at DESC LIMIT $2`,
    [userId, limit],
  );
  const ids = rows.map((r) => r.id);
  const reactions = ids.length
    ? await query<{ surfacing_id: string; reaction: string | null }>(
        `SELECT surfacing_id, reaction FROM viral_benchmarks WHERE surfacing_id = ANY($1::uuid[])`,
        [ids],
      )
    : [];
  const reactionMap = new Map(reactions.map((r) => [r.surfacing_id, r.reaction]));
  return rows.map((r) => ({
    id: r.id,
    deliveredAt: r.delivered_at,
    author: r.payload?.author ?? "",
    viewCount: r.payload?.view_count ?? 0,
    breakoutRatio: typeof r.payload?.breakout_ratio === "number" ? r.payload.breakout_ratio : null,
    sourceUrl: r.payload?.source_url ?? null,
    sourceNote: r.payload?.source_note ?? null,
    reaction: reactionMap.get(r.id) ?? null,
  }));
}
