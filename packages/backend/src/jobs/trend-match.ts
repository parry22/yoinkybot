import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES } from "./boss.js";
import { llmCall } from "../llm/gateway.js";
import { macroMatch } from "../prompts/macro-match.v1.js";
import { activePositions } from "../memory/positions.js";
import { entitlementsFor } from "../billing/entitlements.js";

/** At most this many trend-driven offers per user per 30 days — rarity is the feature. */
const TREND_MONTHLY_CAP = 4;

const matchSchema = z.object({
  match: z
    .object({
      position_id: z.string(),
      url: z.string(),
      title: z.string(),
      why_now: z.string(),
    })
    .nullable(),
});

/**
 * Daily per-user matching of the shared `trends` table against stated positions.
 * Deterministic pgvector prefilter → high-threshold LLM gate (reuses the
 * macro-match prompt's bar: weak matches never fire). A match becomes a `trend`
 * moment and flows into the SAME angle-offer delivery as browsing moments —
 * "the conversation came to you, here's how to join it as yourself".
 */
export async function handleTrendMatch(): Promise<void> {
  const users = await query<{ id: string }>(`SELECT id FROM users WHERE telegram_id IS NOT NULL`);
  for (const { id } of users) {
    try {
      const ent = await entitlementsFor(id);
      if (!ent.macroMatching) continue;
      await trendMatchForUser(id);
    } catch (err) {
      console.error(`trend match failed for ${id}`, err);
    }
  }
}

export async function trendMatchForUser(userId: string): Promise<boolean> {
  const monthCount = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM moments
     WHERE user_id = $1 AND kind = 'trend' AND created_at > now() - interval '30 days'`,
    [userId],
  );
  if (Number(monthCount?.count ?? 0) >= TREND_MONTHLY_CAP) return false;

  const positions = await activePositions(userId);
  if (positions.length === 0) return false;

  // Deterministic prefilter: recent trends semantically near ANY of the user's positions.
  const candidates = await query<{
    id: string;
    topic: string;
    summary: string;
    url: string | null;
    platform: string;
    distance: number;
  }>(
    `SELECT t.id, t.topic, t.summary, t.url, t.platform,
            (SELECT min(t.embedding <=> p.embedding) FROM positions p
             WHERE p.user_id = $1 AND p.status = 'active' AND p.embedding IS NOT NULL) AS distance
     FROM trends t
     WHERE t.fetched_at > now() - interval '3 days' AND t.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM moments m WHERE m.user_id = $1 AND m.trend_id = t.id)
     ORDER BY distance ASC NULLS LAST
     LIMIT 8`,
    [userId],
  );
  // Loose prefilter — it only exists to drop clearly unrelated trends; the LLM
  // gate below is the real (high) bar. text-embedding-v4 puts on-topic
  // paraphrases around 0.55-0.65 distance, so 0.7 keeps them in play.
  const near = candidates.filter((c) => c.distance !== null && c.distance < 0.7);
  if (near.length === 0) return false;

  const themeRows = await query<{ label: string }>(
    `SELECT label FROM clusters WHERE user_id = $1 ORDER BY array_length(memory_ids,1) DESC LIMIT 5`,
    [userId],
  );
  // Weight matching toward the active plan's throughline + stated goal (spec 5).
  const planRow = await queryOne<{ throughline: string }>(
    `SELECT throughline FROM brand_plans WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const goalRow = await queryOne<{ detail: string }>(
    `SELECT detail FROM goals WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const themes = [
    ...(planRow?.throughline ? [`THROUGHLINE: ${planRow.throughline}`] : []),
    ...(goalRow?.detail ? [`GOAL: ${goalRow.detail}`] : []),
    ...themeRows.map((t) => t.label),
  ];

  const res = await llmCall({
    userId,
    eventType: "trend_match",
    tier: macroMatch.tier,
    system: macroMatch.system,
    user: macroMatch.render({
      discourse: near.map((c) => ({ title: c.topic, snippet: c.summary, url: c.url ?? "" })),
      positions: positions.slice(0, 20).map((p) => ({ id: p.id, statement: p.statement })),
      themes,
    }),
    json: true,
    maxTokens: 512,
  });
  const parsed = matchSchema.parse(res.parsed);
  if (!parsed.match) return false;
  const trend = near.find((c) => c.url === parsed.match!.url || c.topic === parsed.match!.title) ?? near[0]!;
  const position = positions.find((p) => p.id === parsed.match!.position_id);
  if (!position) return false;

  // The match becomes a shareable trend moment; angle-offer handles delivery + cadence.
  const moment = await queryOne<{ id: string }>(
    `INSERT INTO moments (user_id, profile_id, kind, url, title, excerpt, signals, shareability, verdict, verdict_reason, trend_id, gated_at)
     VALUES ($1,$1,'trend',$2,$3,$4,$5,0.9,'shareable',$6,$7, now()) RETURNING id`,
    [
      userId,
      trend.url,
      trend.topic,
      `${trend.summary}\n\nYour stated position: "${position.statement}"`,
      JSON.stringify({ platform: trend.platform, why_now: parsed.match.why_now, position_id: position.id }),
      parsed.match.why_now,
      trend.id,
    ],
  );
  if (!moment) return false;

  await getBoss().send(QUEUES.offerAngles, { momentId: moment.id, userId });
  return true;
}
