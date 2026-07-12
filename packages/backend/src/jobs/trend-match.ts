import { z } from "zod";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES } from "./boss.js";
import { llmCall } from "../llm/gateway.js";
import { runToolLoop } from "../llm/tool-loop.js";
import { macroMatch } from "../prompts/macro-match.v1.js";
import { trendTake } from "../prompts/trend-take.v1.js";
import { trendTakeToolSchema } from "../trends/tools.js";
import { verifyTrendVolume, twitterapiConfigured, type VolumeVerification } from "../trends/providers/twitterapi.js";
import { activePositions, type WeightedPosition } from "../memory/positions.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile } from "../strategist/profile.js";
import { activeGoals } from "../strategist/goals.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { canDeliverProactive } from "../surfacing/cadence.js";
import { casualize, enforceStyle } from "../prompts/style.js";
import { sendTelegram } from "../telegram/bot.js";
import type { UserSettings } from "../lib/time.js";

/** At most this many trend-driven offers per user per 30 days — rarity is the feature. */
const TREND_MONTHLY_CAP = 4;
/** Volume-verify at most this many niche-nearest candidates per user per run —
 *  no point paying for tweet volume on a topic that's nowhere near their niche. */
const VERIFY_CANDIDATES = 3;

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

const takeSchema = z.object({
  fires: z.boolean().catch(false),
  reply: z.string().catch(""),
  embedded_draft: z.string().nullish(),
  angle: z.string().catch(""),
  cited_memory_ids: z.array(z.string()).catch([]),
  confidence: z.number().min(0).max(1).catch(0),
});

interface TrendCandidate {
  id: string;
  topic: string;
  summary: string;
  url: string | null;
  platform: string;
  distance: number;
}

/**
 * The macro-moment pipeline, per user. Deterministic gates in code, in order —
 * only a candidate that clears all of them reaches the composition agent:
 *
 *   daily/monthly caps → Stage C niche gate (pgvector vs positions, cheap,
 *   BEFORE any twitterapi.io spend) → Stage B buzz gate (verified volume via
 *   advanced_search, buzzScore > BUZZ_THRESHOLD) → Stage D position gate (the
 *   high-bar macro-match LLM compare, unchanged) → the trend-take agent
 *   (research + composition only; it can decline to fire, never select).
 *
 * Runs a few times a day but sends at most once: the first run that produces a
 * firing take wins; later runs bail on the already-sent check before any LLM
 * work. Without TWITTERAPI_IO_KEY the volume gate can't run, so the pipeline
 * degrades to the previous behavior (niche + position gate → angle offer).
 */
export async function handleTrendMatch(): Promise<void> {
  const users = await query<{ id: string; settings: UserSettings }>(
    `SELECT id, settings FROM users WHERE telegram_id IS NOT NULL`,
  );
  for (const u of users) {
    try {
      const ent = await entitlementsFor(u.id);
      if (!ent.macroMatching) continue;
      await trendMatchForUser(u.id, u.settings ?? {});
    } catch (err) {
      console.error(`trend match failed for ${u.id}`, err);
    }
  }
}

export async function trendMatchForUser(userId: string, settings: UserSettings = {}): Promise<boolean> {
  // At most one send a day: the first run that fires wins, later runs bail
  // here before any LLM or provider work. A run where the agent DECLINED
  // doesn't burn the day — a later run may try a different trend (per-trend
  // dedup below stops the same one being reconsidered). The degraded path has
  // no agent decline, so there the old once-a-day moment check applies.
  const today = twitterapiConfigured()
    ? await queryOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM surfacings
         WHERE user_id = $1 AND type = 'trend_take' AND delivered_at > date_trunc('day', now())`,
        [userId],
      )
    : await queryOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM moments
         WHERE user_id = $1 AND kind = 'trend' AND created_at > date_trunc('day', now())`,
        [userId],
      );
  if (Number(today?.n ?? 0) > 0) return false;

  // Monthly cap counts OFFERS THE USER ACTUALLY GOT, not attempts: a moment the
  // agent declined / the budget held / the send dropped is verdict='rejected'
  // below, and must not starve the rest of the month — 4 invisible declines
  // used to silently kill trend delivery for 30 days.
  const monthCount = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM moments
     WHERE user_id = $1 AND kind = 'trend' AND verdict <> 'rejected'
       AND created_at > now() - interval '30 days'`,
    [userId],
  );
  if (Number(monthCount?.count ?? 0) >= TREND_MONTHLY_CAP) return false;

  const positions = await activePositions(userId);
  if (positions.length === 0) return false;

  // Stage C — niche gate (deterministic): recent trends semantically near ANY of
  // the user's positions. Runs BEFORE the paid volume checks.
  const candidates = await query<TrendCandidate>(
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
  // paraphrases around 0.55-0.65 distance.
  const near = candidates.filter((c) => c.distance !== null && c.distance < config.NICHE_THRESHOLD);
  if (near.length === 0) return false;

  // Stage B — buzz gate (deterministic, verified volume). Skipped when
  // twitterapi.io isn't configured: the pipeline then degrades to the previous
  // niche+position-gate → angle-offer behavior.
  let surviving = near;
  const verifications = new Map<string, VolumeVerification>();
  if (twitterapiConfigured()) {
    surviving = [];
    for (const c of near.slice(0, VERIFY_CANDIDATES)) {
      try {
        const v = await verifyTrendVolume(c.topic, true);
        if (v.buzz > config.BUZZ_THRESHOLD) {
          verifications.set(c.id, v);
          surviving.push(c);
        }
      } catch (err) {
        console.error(`buzz verification failed for trend "${c.topic}"`, err);
      }
    }
    surviving.sort((a, b) => (verifications.get(b.id)?.buzz ?? 0) - (verifications.get(a.id)?.buzz ?? 0));
    if (surviving.length === 0) return false;
  }

  // Stage D — position gate (unchanged high-bar semantic compare; fires rarely,
  // weak matches never fire).
  const themeRows = await query<{ label: string }>(
    `SELECT label FROM clusters WHERE user_id = $1 ORDER BY array_length(memory_ids,1) DESC LIMIT 5`,
    [userId],
  );
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
      discourse: surviving.map((c) => ({ title: c.topic, snippet: c.summary, url: c.url ?? "" })),
      positions: positions.slice(0, 20).map((p) => ({ id: p.id, statement: p.statement })),
      themes,
    }),
    json: true,
    maxTokens: 512,
  });
  const parsed = matchSchema.parse(res.parsed);
  if (!parsed.match) return false;
  const trend = surviving.find((c) => c.url === parsed.match!.url || c.topic === parsed.match!.title) ?? surviving[0]!;
  const position = positions.find((p) => p.id === parsed.match!.position_id);
  if (!position) return false;

  const verification = verifications.get(trend.id);

  // The match becomes a trend moment either way — it anchors the daily/monthly
  // caps and the per-trend dedup, and keeps the timeline inspectable.
  const moment = await queryOne<{ id: string }>(
    `INSERT INTO moments (user_id, profile_id, kind, url, title, excerpt, signals, shareability, verdict, verdict_reason, trend_id, gated_at)
     VALUES ($1,$1,'trend',$2,$3,$4,$5,0.9,'shareable',$6,$7, now()) RETURNING id`,
    [
      userId,
      trend.url,
      trend.topic,
      `${trend.summary}\n\nYour stated position: "${position.statement}"`,
      JSON.stringify({
        platform: trend.platform,
        why_now: parsed.match.why_now,
        position_id: position.id,
        ...(verification ? { buzz: verification.buzz, buzz_signals: verification.signals } : {}),
      }),
      parsed.match.why_now,
      trend.id,
    ],
  );
  if (!moment) return false;

  // Degraded path (no volume verification available): the previous delivery —
  // the moment flows into the shared angle-offer pipeline.
  if (!verification) {
    await getBoss().send(QUEUES.offerAngles, { momentId: moment.id, userId });
    return true;
  }

  return composeAndDeliverTake(userId, settings, {
    momentId: moment.id,
    trend,
    position,
    whyNow: parsed.match.why_now,
    verification,
  });
}

/**
 * A trend moment that never reached the user: record WHY on the moment row
 * (verdict 'rejected' + reason) instead of silently returning false. This is
 * both observability — "why did nothing fire this week?" is answerable from
 * SQL — and correctness: the monthly cap above only counts non-rejected
 * moments, so declines can't starve a month of delivery.
 */
async function rejectMoment(momentId: string, reason: string): Promise<void> {
  await query(`UPDATE moments SET verdict = 'rejected', verdict_reason = $2 WHERE id = $1`, [momentId, reason]);
  console.log(`trend moment ${momentId} rejected: ${reason}`);
}

/**
 * The composition agent + distinct delivery. The agent researches (cached
 * tweets, memory, voice, goals, the gate data) and either writes a grounded
 * take or declines — a skipped moment costs nothing, a forced one costs trust.
 */
async function composeAndDeliverTake(
  userId: string,
  settings: UserSettings,
  input: {
    momentId: string;
    trend: TrendCandidate;
    position: WeightedPosition;
    whyNow: string;
    verification: VolumeVerification;
  },
): Promise<boolean> {
  const { trend, position, verification } = input;

  const executors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    get_top_tweets: async (args) => {
      const stance = String(args.stance ?? "").toLowerCase();
      const terms = stance.split(/\W+/).filter((w) => w.length > 3);
      const pool = terms.length
        ? verification.topTweets.filter((t) => terms.some((w) => t.text.toLowerCase().includes(w)))
        : verification.topTweets;
      const picked = (pool.length ? pool : verification.topTweets).slice(0, 8);
      if (picked.length === 0) return "no verified tweets in the pool";
      return picked
        .map((t) => `@${t.authorHandle} (${t.likeCount}♥/${t.retweetCount}rt/${t.replyCount}re): ${t.text.slice(0, 220)}`)
        .join("\n");
    },
    search_memory: async (args) => {
      const rows = await hybridSearch(userId, String(args.query ?? ""), 5);
      if (rows.length === 0) return "nothing in memory matches";
      return rows.map((m) => `- [${m.id}] (${m.kind}, ${m.created_at.slice(0, 10)}) ${m.content.slice(0, 280)}`).join("\n");
    },
    get_voice_profile: async () => {
      const profile = await currentVoiceProfile(userId);
      return profile?.traits ? JSON.stringify(profile.traits).slice(0, 900) : "no voice profile built yet";
    },
    get_goals_and_pillars: async () => {
      const [goals, profile] = await Promise.all([activeGoals(userId).catch(() => []), getProfile(userId)]);
      const bits = [
        goals[0]?.detail ? `goal: ${goals[0].detail}` : "",
        profile?.niche ? `niche: ${profile.niche}` : "",
        profile?.content_pillars.length ? `pillars: ${profile.content_pillars.join("; ")}` : "",
        profile?.topics_off_limits.length ? `OFF-LIMITS topics: ${profile.topics_off_limits.join("; ")}` : "",
      ].filter(Boolean);
      return bits.length ? bits.join("\n") : "no goals or brand profile yet";
    },
    get_positions: async () => {
      const others = (await activePositions(userId)).slice(0, 8);
      return (
        `matched position (cleared the gate): "${position.statement}" — ${input.whyNow}\n` +
        `their other active positions:\n${others.map((p) => `- ${p.statement}`).join("\n")}`
      );
    },
  };

  const { output, steps } = await runToolLoop({
    userId,
    eventType: "trend_take",
    tier: trendTake.tier,
    system: trendTake.system,
    renderUser: (notes) =>
      trendTake.render({
        trend: { topic: trend.topic, summary: trend.summary, url: trend.url },
        buzz: verification.signals,
        match: { positionStatement: position.statement, whyNow: input.whyNow },
        toolNotes: notes,
        toolCallsRemaining: Math.max(0, config.TREND_TAKE_MAX_TOOL_CALLS - notes.length),
      }),
    toolSchema: trendTakeToolSchema,
    executors,
    outputSchema: takeSchema,
    maxToolCalls: config.TREND_TAKE_MAX_TOOL_CALLS,
    maxTokens: 800,
  });

  if (!output.fires || !output.reply.trim()) {
    await rejectMoment(input.momentId, `agent declined: ${output.angle || "no real angle for this user"}`);
    return false;
  }

  // Right time, not just right thing: quiet hours + the shared proactive budget.
  const cadence = await canDeliverProactive(userId, settings);
  if (!cadence.ok) {
    await rejectMoment(input.momentId, `held by cadence: ${cadence.reason}`);
    return false;
  }

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'trend_take', $2, 'telegram') RETURNING id`,
    [
      userId,
      JSON.stringify({
        moment_id: input.momentId,
        trend_id: trend.id,
        angle: output.angle,
        confidence: output.confidence,
        cited_memory_ids: output.cited_memory_ids,
        buzz: verification.buzz,
        agent_steps: steps.map((s) => ({ tool: s.tool, args: s.args })),
      }),
    ],
  );
  if (!surfacing) return false;

  // Distinct delivery treatment: no 🔥/💤/🗑 resurfacing card — this should read
  // as "this is different" before they even open it. The wrapper is Yoinky
  // talking (casual); an embedded draft is feed content and stays untouched.
  const embedded = output.embedded_draft?.trim();
  const message =
    `⚡ ${casualize(output.reply)}` +
    (embedded ? `\n\nif you want the exact words:\n\n${enforceStyle(embedded)}` : "") +
    (trend.url ? `\n\n${trend.url}` : "");
  const sent = await sendTelegram(userId, message).catch(() => false);
  if (!sent) {
    // Don't leave a phantom surfacing that eats the budget for a DM that never landed.
    await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
    await rejectMoment(input.momentId, "telegram send failed");
    return false;
  }
  return true;
}
