import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { runToolLoop } from "../llm/tool-loop.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile } from "../strategist/profile.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";
import { interestThemes } from "./trend-fetch.js";
import { fetchViralPool, selectFromPool } from "../trends/viral-scoring.js";
import type { XTweet } from "../capture/imports/twitterapi-io.js";
import { computeViralHeuristics } from "../trends/viral-heuristics.js";
import { viralCaseStudy } from "../prompts/viral-case-study.v1.js";
import { viralToolSchema } from "../trends/viral-tools.js";
import { casualize, enforceStyle } from "../prompts/style.js";
import { sendTelegram } from "../telegram/bot.js";

/**
 * The daily viral tweet case study (§3h). Once a day, one high-impression,
 * niche-relevant tweet + a computed "why it worked" breakdown + a suggested
 * angle grounded in the user's own voice. Distinct from the macro-moment agent
 * (aggregate discourse) and peer benchmarking (relative to known peers).
 *
 * Selection is entirely deterministic (trends/viral-scoring.ts). This handler
 * gates delivery (own once-a-day budget, NOT the shared proactive cadence),
 * computes the facts, runs the bounded composition agent, delivers, and writes
 * the dedup ledger — only on a real send.
 */

const outputSchema = z.object({
  breakdown: z.string().catch(""),
  angle: z.string().catch(""),
  source_note: z.string().catch(""),
  cited_memory_ids: z.array(z.string()).catch([]),
});

/** 👍 / 👎 feedback on relevance — the tuning surface. Handled in telegram/bot.ts. */
export function viralReactionKeyboard(surfacingId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("👍 useful", `vbfb:${surfacingId}:useful`)
    .text("👎 not my niche", `vbfb:${surfacingId}:off`);
}

export async function handleViralBenchmark(): Promise<void> {
  // The niche seeds are shared across the user base (same distilled themes the
  // trend fetch uses — no second seed pipeline). Compute once per run; the
  // per-user band/niche/dedup gates do the personalizing.
  const themes = await interestThemes().catch((err) => {
    console.error("viral: interestThemes failed", err);
    return [] as string[];
  });
  if (themes.length === 0) return;

  // Fetch the candidate pool ONCE for the whole run — the search is identical
  // across users (shared niche seeds), so per-user searching was pure waste and
  // a 429 magnet. Bail before touching the DB if nothing's viral right now.
  const pool = await fetchViralPool(themes);
  if (pool.length === 0) return;

  // Web-only users (connected X, no Telegram) get the same case studies in seed
  // mode (channel 'web', no DM) so their Inspiration feed fills too.
  const users = await query<{ id: string; settings: UserSettings; has_tg: boolean }>(
    `SELECT id, settings, telegram_id IS NOT NULL AS has_tg FROM users
     WHERE telegram_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM connected_accounts ca WHERE ca.user_id = users.id AND ca.platform = 'x')`,
  );
  for (const u of users) {
    try {
      const ent = await entitlementsFor(u.id);
      if (!ent.macroMatching) continue;
      await viralBenchmarkForUser(u.id, pool, u.settings ?? {}, { viralPerDay: ent.viralPerDay, seed: !u.has_tg });
    } catch (err) {
      console.error(`viral benchmark failed for ${u.id}`, err);
    }
  }
}

export async function viralBenchmarkForUser(
  userId: string,
  pool: XTweet[],
  settings: UserSettings = {},
  opts: { skipGates?: boolean; seed?: boolean; viralPerDay?: number | null } = {},
): Promise<boolean> {
  // seed mode: web-only pre-population (no Telegram). Persist the surfacing with
  // channel 'web' and skip the send-and-delete tail so a Telegram-less web user
  // gets inspiration to look at right after connecting.
  const seed = opts.seed === true;
  if (!opts.skipGates && !seed) {
    // Per-plan daily budget (Growth = 1/day, Scale = unlimited) — NOT the shared
    // proactive cadence cap. A different kind of value (an external reference
    // example), so it gets its own slot rather than competing with resurfacing.
    const cap = opts.viralPerDay !== undefined ? opts.viralPerDay : (await entitlementsFor(userId)).viralPerDay;
    if (cap !== null) {
      const today = await queryOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM viral_benchmarks
         WHERE user_id = $1 AND sent_at > date_trunc('day', now())`,
        [userId],
      );
      if (Number(today?.n ?? 0) >= cap) return false;
    }
    if (inQuietHours(settings)) return false;
  }

  const pick = await selectFromPool(userId, pool);
  if (!pick) return false;
  const { tweet } = pick;

  const facts = computeViralHeuristics({
    viewCount: tweet.viewCount,
    likeCount: tweet.likeCount,
    retweetCount: tweet.retweetCount,
    replyCount: tweet.replyCount,
    quoteCount: tweet.quoteCount,
    bookmarkCount: tweet.bookmarkCount,
    authorFollowers: tweet.authorFollowers,
    postedAtMs: tweet.createdAt.getTime(),
    nowMs: Date.now(),
    hasMedia: tweet.hasMedia,
    text: tweet.text,
  });

  const executors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    get_voice_profile: async () => {
      const profile = await currentVoiceProfile(userId);
      return profile?.traits ? JSON.stringify(profile.traits).slice(0, 900) : "no voice profile yet — default plain and direct";
    },
    get_content_pillars: async () => {
      const profile = await getProfile(userId);
      if (!profile) return "no brand profile yet";
      return [
        profile.niche ? `niche: ${profile.niche}` : "",
        profile.content_pillars.length ? `pillars: ${profile.content_pillars.join("; ")}` : "no pillars set",
        profile.topics_off_limits.length ? `OFF-LIMITS: ${profile.topics_off_limits.join("; ")}` : "",
      ].filter(Boolean).join("\n");
    },
    search_memory: async (args) => {
      const rows = await hybridSearch(userId, String(args.query ?? ""), 5);
      if (rows.length === 0) return "nothing in memory matches";
      return rows.map((m) => `- [${m.id}] (${m.kind}, ${m.created_at.slice(0, 10)}) ${m.content.slice(0, 280)}`).join("\n");
    },
  };

  const { output } = await runToolLoop({
    userId,
    eventType: "viral_case_study",
    tier: viralCaseStudy.tier,
    system: viralCaseStudy.system,
    renderUser: (notes) =>
      viralCaseStudy.render({
        tweet: { authorHandle: tweet.authorHandle, text: tweet.text, url: tweet.url },
        facts,
        toolNotes: notes,
        toolCallsRemaining: Math.max(0, config.VIRAL_MAX_TOOL_CALLS - notes.length),
      }),
    toolSchema: viralToolSchema,
    executors,
    outputSchema,
    maxToolCalls: config.VIRAL_MAX_TOOL_CALLS,
    maxTokens: 700,
  });

  if (!output.breakdown.trim() || !output.angle.trim()) return false;

  // Distinct framing: 📈 case-study, clearly an OUTSIDE example (not the ⚡
  // trend-take, not a 🔥/💤/🗑 resurfaced memory). Breakdown/angle are Yoinky
  // talking (casual); an angle with exact post language is feed content.
  const angle = output.angle.trim();
  const looksLikeDraft = angle.length > 120 || /[.!?]"?\s/.test(angle);
  const message =
    `📈 viral in your niche — worth a look at why\n\n` +
    `@${tweet.authorHandle} just did ${facts.view_count.toLocaleString()} views (${facts.breakout_ratio}x their following).\n\n` +
    `${casualize(output.breakdown.trim())}\n\n` +
    `💡 your angle:\n${looksLikeDraft ? enforceStyle(angle) : casualize(angle)}` +
    (output.source_note.trim() ? `\n\nwhat the post says: ${casualize(output.source_note.trim())}` : "") +
    (tweet.url ? `\n${tweet.url}` : "");

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'viral_benchmark', $2, $3) RETURNING id`,
    [
      userId,
      JSON.stringify({
        tweet_id: tweet.id,
        author: tweet.authorHandle,
        view_count: tweet.viewCount,
        breakout_ratio: facts.breakout_ratio,
        niche_distance: pick.nicheDistance,
        score: pick.score,
        source_url: tweet.url,
        source_note: output.source_note || null,
        cited_memory_ids: output.cited_memory_ids,
      }),
      seed ? "web" : "telegram",
    ],
  );
  if (!surfacing) return false;

  if (!seed) {
    const sent = await sendTelegram(userId, message, undefined, viralReactionKeyboard(surfacing.id)).catch(() => false);
    if (!sent) {
      await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
      return false;
    }
  }

  // Ledger for dedup + the daily gate. In seed mode there's no send, but we still
  // record it so the scheduled job never re-surfaces the same tweet.
  await query(
    `INSERT INTO viral_benchmarks (user_id, tweet_id, author_handle, view_count, url, surfacing_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, tweet_id) DO NOTHING`,
    [userId, tweet.id, tweet.authorHandle, tweet.viewCount, tweet.url, surfacing.id],
  );
  return true;
}
