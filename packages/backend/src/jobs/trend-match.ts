import { z } from "zod";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES } from "./boss.js";
import { llmCall } from "../llm/gateway.js";
import { runAgentLoop } from "../agent-runtime/run-agent-loop.js";
import { macroMatch } from "../prompts/macro-match.v1.js";
import { trendTake } from "../prompts/trend-take.v2.js";
import { trendTakeToolSchema } from "../trends/tools.js";
import { verifyTrendVolume, twitterapiConfigured, type VolumeVerification } from "../trends/providers/twitterapi.js";
import { activePositions, type WeightedPosition } from "../memory/positions.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile } from "../strategist/profile.js";
import { activeGoals } from "../strategist/goals.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { casualize, enforceStyle } from "../prompts/style.js";
import { sendTelegram } from "../telegram/bot.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";

/** Volume-verify at most this many niche-nearest candidates per user per run —
 *  no point paying for tweet volume on a topic that's nowhere near their niche.
 *  Kept a touch above MAX_DAILY_TREND_SENDS so a run can still fill the day's
 *  band even if one or two verified candidates fail the position gate. */
const VERIFY_CANDIDATES = 5;

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
  // The specific post driving the volume: permalink + a short paraphrase (never
  // a long quote). The whole point of the v2 delivery — the user sees exactly
  // what they'd be riding.
  source_url: z.string().nullish(),
  source_note: z.string().catch(""),
  embedded_draft: z.string().nullish(),
  angle: z.string().catch(""),
  cited_memory_ids: z.array(z.string()).catch([]),
  confidence: z.number().min(0).max(1).catch(0),
});

export interface TrendCandidate {
  id: string;
  topic: string;
  summary: string;
  url: string | null;
  platform: string;
  distance: number;
  /** Id of the user's active position nearest this trend (deterministic argmin).
   *  Used as grounding context for the compose agent — NOT a hard collision gate. */
  nearest_position_id: string | null;
}

/**
 * The macro-moment pipeline, per user. Deterministic gates in code, in order —
 * only a candidate that clears all of them reaches the composition agent:
 *
 *   daily band → Stage C niche gate (pgvector vs positions, cheap, BEFORE any
 *   twitterapi.io spend) → Stage B buzz gate (verified volume via
 *   advanced_search, buzzScore > BUZZ_THRESHOLD) → rank by buzzScore → Stage D
 *   position gate (per-trend macro-match compare) → the trend-take agent
 *   (research + composition only; it can decline to fire, never select).
 *
 * WHICH trends and HOW MANY is decided entirely in code (2026-07-12 rework):
 * buzz-verified survivors are ranked by buzzScore and taken top-down until the
 * day's remaining band (MAX_DAILY_TREND_SENDS − already delivered today) is
 * filled, aiming for MIN_DAILY_TREND_SENDS while qualifying candidates last.
 * The position gate now runs PER TREND — a yes/no + which-position judgment on a
 * single candidate — not as a cross-trend pick, so the model never selects
 * which trend to cover. (This replaced the old single-send-a-day + 4-per-month
 * rarity caps; see config.MIN/MAX_DAILY_TREND_SENDS.)
 *
 * Runs a few times a day; each run tops up toward the band and bails before any
 * provider spend once the ceiling is hit. Without TWITTERAPI_IO_KEY the volume
 * gate can't run, so the pipeline degrades to the previous behavior (niche +
 * single position gate → angle offer).
 */
export async function handleTrendMatch(): Promise<void> {
  // Telegram users get the DM delivery; web-only users (connected X, no
  // Telegram) get the same surfacings in seed mode (channel 'web', no DM) so the
  // web Inspiration feed fills and stays fresh for them too — it used to only
  // ever populate for Telegram-linked accounts.
  const users = await query<{ id: string; settings: UserSettings; has_tg: boolean }>(
    `SELECT id, settings, telegram_id IS NOT NULL AS has_tg FROM users
     WHERE telegram_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM connected_accounts ca WHERE ca.user_id = users.id AND ca.platform = 'x')`,
  );
  for (const u of users) {
    try {
      const ent = await entitlementsFor(u.id);
      if (!ent.macroMatching) continue;
      await trendMatchForUser(u.id, u.settings ?? {}, { seed: !u.has_tg });
    } catch (err) {
      console.error(`trend match failed for ${u.id}`, err);
    }
  }
}

/** The shared theme context handed to the per-trend position gate. */
async function gatherThemes(userId: string): Promise<string[]> {
  const [themeRows, planRow, goalRow] = await Promise.all([
    query<{ label: string }>(
      `SELECT label FROM clusters WHERE user_id = $1 ORDER BY array_length(memory_ids,1) DESC LIMIT 5`,
      [userId],
    ),
    queryOne<{ throughline: string }>(
      `SELECT throughline FROM brand_plans WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
    queryOne<{ detail: string }>(
      `SELECT detail FROM goals WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
  ]);
  return [
    ...(planRow?.throughline ? [`THROUGHLINE: ${planRow.throughline}`] : []),
    ...(goalRow?.detail ? [`GOAL: ${goalRow.detail}`] : []),
    ...themeRows.map((t) => t.label),
  ];
}

/**
 * Stage D as a PER-TREND gate: does any of this user's stated positions collide
 * with THIS one trend, hard enough to clear the high-bar macro-match compare?
 * Returns the matched position + why-now, or null. Selection across trends is
 * done in code (buzzScore rank) before this runs — the model only judges one
 * candidate at a time, never picks which to cover.
 */
async function runPositionGate(
  userId: string,
  trend: TrendCandidate,
  positions: WeightedPosition[],
  themes: string[],
): Promise<{ position: WeightedPosition; whyNow: string } | null> {
  const res = await llmCall({
    userId,
    eventType: "trend_match",
    tier: macroMatch.tier,
    system: macroMatch.system,
    user: macroMatch.render({
      discourse: [{ title: trend.topic, snippet: trend.summary, url: trend.url ?? "" }],
      positions: positions.slice(0, 20).map((p) => ({ id: p.id, statement: p.statement })),
      themes,
    }),
    json: true,
    maxTokens: 512,
  });
  const parsed = matchSchema.parse(res.parsed);
  if (!parsed.match) return null;
  const position = positions.find((p) => p.id === parsed.match!.position_id);
  if (!position) return null;
  return { position, whyNow: parsed.match.why_now };
}

/**
 * Record the gated trend as a moment — the anchor for the daily-band count, the
 * per-trend dedup (the niche query excludes trends that already have a moment),
 * and timeline inspection. `position`/`whyNow` are null for a moment created
 * only to tombstone a candidate that failed the position gate.
 */
async function createTrendMoment(
  userId: string,
  trend: TrendCandidate,
  position: WeightedPosition | null,
  whyNow: string | null,
  verification?: VolumeVerification,
): Promise<string | null> {
  const excerpt = position
    ? `${trend.summary}\n\nYour stated position: "${position.statement}"`
    : trend.summary;
  const moment = await queryOne<{ id: string }>(
    `INSERT INTO moments (user_id, profile_id, kind, url, title, excerpt, signals, shareability, verdict, verdict_reason, trend_id, gated_at)
     VALUES ($1,$1,'trend',$2,$3,$4,$5,0.9,'shareable',$6,$7, now()) RETURNING id`,
    [
      userId,
      trend.url,
      trend.topic,
      excerpt,
      JSON.stringify({
        platform: trend.platform,
        ...(whyNow ? { why_now: whyNow } : {}),
        ...(position ? { position_id: position.id } : {}),
        ...(verification ? { buzz: verification.buzz, buzz_signals: verification.signals } : {}),
      }),
      whyNow,
      trend.id,
    ],
  );
  return moment?.id ?? null;
}

/** A trend that cleared the niche + buzz gates, with its grounding, ranked by buzz. */
export interface RankedTrend {
  trend: TrendCandidate;
  position: WeightedPosition;
  whyNow: string;
  verification: VolumeVerification;
  buzz: number;
}

/**
 * Shared niche prefilter: the user's active positions + recent on-niche X trends
 * that don't already have a moment, near-gated by NICHE_THRESHOLD. Pure read.
 * Both the verified selector and the degraded fallback consume this, so the niche
 * gate is defined once.
 */
async function nicheCandidates(
  userId: string,
): Promise<{ positions: WeightedPosition[]; near: TrendCandidate[] } | null> {
  const positions = await activePositions(userId);
  if (positions.length === 0) return null;
  const candidates = await query<TrendCandidate>(
    `SELECT t.id, t.topic, t.summary, t.url, t.platform,
            (SELECT min(t.embedding <=> p.embedding) FROM positions p
             WHERE p.user_id = $1 AND p.status = 'active' AND p.embedding IS NOT NULL) AS distance,
            (SELECT p.id FROM positions p
             WHERE p.user_id = $1 AND p.status = 'active' AND p.embedding IS NOT NULL
             ORDER BY t.embedding <=> p.embedding ASC LIMIT 1) AS nearest_position_id
     FROM trends t
     WHERE t.fetched_at > now() - interval '3 days'
       AND t.observed_at > now() - interval '36 hours'
       AND t.embedding IS NOT NULL
       AND t.platform = 'x'
       AND t.source = 'twitterapi'
       AND NOT EXISTS (SELECT 1 FROM moments m WHERE m.user_id = $1 AND m.trend_id = t.id)
     ORDER BY distance ASC NULLS LAST
     LIMIT 12`,
    [userId],
  );
  const near = candidates.filter((c) => c.distance !== null && c.distance < config.NICHE_THRESHOLD);
  if (near.length === 0) return null;
  return { positions, near };
}

/**
 * The deterministic "ranked eligible trends for a user" selector: niche gate →
 * buzz verification (BUZZ_THRESHOLD) → rank by buzzScore. PURE READ — creates no
 * moment and delivers nothing, so it's safe to call from multiple consumers (the
 * proactive `⚡` nudge AND automations) without one hiding trends from the other.
 * Returns [] on the degraded (no-twitterapi) path — callers handle their own
 * fallback. NO LLM.
 */
export async function selectEligibleTrends(userId: string): Promise<RankedTrend[]> {
  if (!twitterapiConfigured()) return [];
  const nc = await nicheCandidates(userId);
  if (!nc) return [];
  const { positions, near } = nc;
  const verifications = new Map<string, VolumeVerification>();
  const surviving: TrendCandidate[] = [];
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
  return surviving.map((trend) => {
    const verification = verifications.get(trend.id)!;
    const position = positions.find((p) => p.id === trend.nearest_position_id) ?? positions[0]!;
    return {
      trend,
      position,
      whyNow: `"${trend.topic}" is surging on X right now and sits squarely in your lane`,
      verification,
      buzz: verification.buzz,
    };
  });
}

export async function trendMatchForUser(
  userId: string,
  settings: UserSettings = {},
  opts: { seed?: boolean } = {},
): Promise<boolean> {
  const seed = opts.seed === true;
  const verified = twitterapiConfigured();

  // Explicit daily-band check. MAX is the hard ceiling: bail here before any LLM
  // or provider spend once it's hit. The loop below fills toward MIN while
  // qualifying candidates last (it can't manufacture buzz, so a quiet day sends
  // fewer). Verified path counts delivered trend_take surfacings; the degraded
  // path has no such delivery, so it counts trend moments created today.
  const sentRow = verified
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
  const remaining = config.MAX_DAILY_TREND_SENDS - Number(sentRow?.n ?? 0);
  if (remaining <= 0) return false;

  // Degraded path (no volume verification available): no buzz to rank by, so
  // take the nearest on-niche candidate that clears the position gate and hand
  // it to the shared angle-offer flow (the pre-buzz behavior). Only this path
  // still uses the per-trend position gate + themes. Niche gate via the shared
  // nicheCandidates helper (defined once, above).
  if (!verified) {
    const nc = await nicheCandidates(userId);
    if (!nc) return false;
    const themes = await gatherThemes(userId);
    for (const c of nc.near) {
      const gate = await runPositionGate(userId, c, nc.positions, themes);
      if (!gate) continue;
      const momentId = await createTrendMoment(userId, c, gate.position, gate.whyNow);
      if (!momentId) return false;
      await getBoss().send(QUEUES.offerAngles, { momentId, userId });
      return true;
    }
    return false;
  }

  // Verified path — the SAME deterministic selector the automation uses (niche →
  // buzz → rank), so there is one definition of eligibility. Compose per trend in
  // buzzScore order, bounded by BOTH the per-run cap (MIN) and the remaining daily
  // band (MAX − sent today); the smaller wins. We attach the NEAREST position as
  // grounding and let the compose agent decide (it declines when there's no angle).
  const ranked = await selectEligibleTrends(userId);
  if (ranked.length === 0) return false;
  const perRun = Math.min(remaining, Math.max(1, config.MIN_DAILY_TREND_SENDS));
  let sent = 0;
  for (const { trend, position, whyNow, verification } of ranked) {
    if (sent >= perRun) break;
    const momentId = await createTrendMoment(userId, trend, position, whyNow, verification);
    if (!momentId) continue;
    const delivered = await composeAndDeliverTake(
      userId,
      settings,
      { momentId, trend, position, whyNow, verification },
      { seed },
    );
    if (delivered) sent++;
  }
  return sent > 0;
}

/**
 * A trend moment that never reached the user: record WHY on the moment row
 * (verdict 'rejected' + reason) instead of silently returning false, so "why
 * did nothing fire this week?" is answerable from SQL. It also anchors the
 * per-trend dedup (the niche query skips any trend that already has a moment),
 * so a rejected candidate isn't re-verified on the next run.
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
export async function composeAndDeliverTake(
  userId: string,
  settings: UserSettings,
  input: {
    momentId: string;
    trend: TrendCandidate;
    position: WeightedPosition;
    whyNow: string;
    verification: VolumeVerification;
  },
  opts: { skipCadence?: boolean; seed?: boolean } = {},
): Promise<boolean> {
  const { trend, position, verification } = input;
  // seed mode: web-only pre-population — persist with channel 'web' and skip the
  // Telegram send-and-delete tail (a web user has no Telegram to deliver to).
  const seed = opts.seed === true;

  const executors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    get_top_tweets: async (args) => {
      const stance = String(args.stance ?? "").toLowerCase();
      const terms = stance.split(/\W+/).filter((w) => w.length > 3);
      const pool = terms.length
        ? verification.topTweets.filter((t) => terms.some((w) => t.text.toLowerCase().includes(w)))
        : verification.topTweets;
      const picked = (pool.length ? pool : verification.topTweets).slice(0, 8);
      if (picked.length === 0) return "no verified tweets in the pool";
      // Include the permalink — the agent needs it to cite the specific post
      // driving the moment (the v2 source-post requirement).
      return picked
        .map(
          (t) =>
            `@${t.authorHandle} [${t.url ?? "no-permalink"}] (${t.likeCount}♥/${t.retweetCount}rt/${t.replyCount}re): ${t.text.slice(0, 220)}`,
        )
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

  const { output, steps } = await runAgentLoop("trend_take", {
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

  // Trends get their OWN cadence, not the shared proactive weekly cap (2026-07-14).
  // The shared cap was being exhausted by own-content resurfacings, so a real
  // trend — the thing users actually ask for — got "weekly cap reached" and never
  // fired. Trend volume is already governed by the daily band (MAX_DAILY_TREND_
  // SENDS, checked in trendMatchForUser); here we only enforce quiet hours + a
  // min-gap between trend sends so they space out. skipCadence bypasses for
  // manual/ops fires.
  if (!opts.skipCadence && !seed) {
    if (inQuietHours(settings)) {
      await rejectMoment(input.momentId, "held: quiet hours");
      return false;
    }
    const recentTrend = await queryOne<{ n: string }>(
      `SELECT count(*)::text n FROM surfacings
       WHERE user_id = $1 AND type = 'trend_take' AND delivered_at > now() - interval '5 hours'`,
      [userId],
    );
    if (Number(recentTrend?.n ?? 0) > 0) {
      await rejectMoment(input.momentId, "held: another trend within 5h");
      return false;
    }
  }

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'trend_take', $2, $3) RETURNING id`,
    [
      userId,
      JSON.stringify({
        moment_id: input.momentId,
        trend_id: trend.id,
        angle: output.angle,
        confidence: output.confidence,
        cited_memory_ids: output.cited_memory_ids,
        buzz: verification.buzz,
        source_url: output.source_url ?? null,
        source_note: output.source_note || null,
        agent_steps: steps.map((s) => ({ tool: s.tool, args: s.args })),
      }),
      seed ? "web" : "telegram",
    ],
  );
  if (!surfacing) return false;

  // Seed mode stops here: the row is what the web Inspiration feed reads; no DM.
  if (seed) return true;

  // Distinct delivery treatment: no 🔥/💤/🗑 resurfacing card — this should read
  // as "this is different" before they even open it. The wrapper is Yoinky
  // talking (casual); an embedded draft is feed content and stays untouched.
  // ONE link, and it's the specific X post driving the volume (source_url from
  // get_top_tweets) — with the trend's own X permalink as the fallback when the
  // agent didn't surface a specific post. We never append the raw trend seed
  // separately: with the X-only candidate filter above every link here is an X
  // link, and a second trailing URL just muddied the message.
  const embedded = output.embedded_draft?.trim();
  const sourceUrl = output.source_url?.trim();
  const sourceNote = output.source_note?.trim();
  const drivingUrl = sourceUrl || trend.url || "";
  const sourceLine = drivingUrl
    ? `\n\nwhat's driving it: ${sourceNote ? `${casualize(sourceNote)}\n` : ""}${drivingUrl}`
    : "";
  const message =
    `⚡ ${casualize(output.reply)}` +
    sourceLine +
    (embedded ? `\n\nif you want the exact words:\n\n${enforceStyle(embedded)}` : "");
  const sent = await sendTelegram(userId, message).catch(() => false);
  if (!sent) {
    // A TRANSPORT failure is not a verdict on the trend. Drop the phantom
    // surfacing (so it can't eat the budget), but DELETE the moment rather than
    // reject it — a rejected moment permanently tombstones this trend for this
    // user (the niche query excludes any trend with a moment), so a transient
    // Telegram blip would kill an otherwise-perfect trend forever. Deleting lets
    // a later run retry it.
    await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
    await query(`DELETE FROM moments WHERE id = $1`, [input.momentId]);
    return false;
  }
  return true;
}
