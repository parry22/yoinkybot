import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { query, queryOne } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { progressReport } from "../prompts/progress-report.v1.js";
import { sendTelegram, sendTelegramSequence, reactionKeyboard } from "../telegram/bot.js";
import { getPlan } from "./plan.js";
import { refreshXEngagement, computePerformance, renderPerformance } from "./performance.js";
import { computePeerComparison } from "../benchmark/peers.js";

/** Minimum gap between progress reads so we don't nag (spec: every 2-4 weeks). */
const MIN_GAP_DAYS = 14;
/** The reporting period never stretches past this, even after a long quiet gap. */
const MAX_PERIOD_DAYS = 30;

const schema = z.object({ messages: z.array(z.string().min(1)).min(1).max(4) });

/** Weekly sweep; only users with an active plan and no recent read get one. */
export async function handleProgressReport(): Promise<void> {
  const users = await query<{ user_id: string }>(
    `SELECT bp.user_id FROM brand_plans bp
     JOIN users u ON u.id = bp.user_id
     WHERE bp.status = 'active' AND u.telegram_id IS NOT NULL`,
  );
  for (const { user_id } of users) {
    try {
      await maybeProgressReport(user_id);
    } catch (err) {
      console.error(`progress report failed for ${user_id}`, err);
    }
  }
}

/**
 * The Monday performance read. Numbers are computed deterministically
 * (strategist/performance.ts) after a metrics refresh; the LLM only explains
 * mechanism and meaning, delivered as a short paced sequence in this single
 * window. Shares this job's schedule + 14-day gate and stays OUTSIDE the shared
 * proactive delivery budget (progress_report is not in PROACTIVE_TYPES).
 */
export async function maybeProgressReport(userId: string): Promise<boolean> {
  const last = await queryOne<{ delivered_at: string }>(
    `SELECT delivered_at::text FROM surfacings
     WHERE user_id = $1 AND type = 'progress_report'
     ORDER BY delivered_at DESC LIMIT 1`,
    [userId],
  );
  const lastAt = last ? new Date(last.delivered_at).getTime() : 0;
  const now = Date.now();
  if (now - lastAt < MIN_GAP_DAYS * 86_400_000) return false;

  const plan = await getPlan(userId);
  if (!plan || plan.status !== "active") return false;

  // The period this report covers: since the last report, bounded so the first
  // one (or one after a long dark stretch) doesn't compare against all of history.
  const periodStart = new Date(Math.max(lastAt, now - MAX_PERIOD_DAYS * 86_400_000));

  // Refresh engagement + ingest posts published since we last looked, THEN measure.
  const refresh = await refreshXEngagement(userId);
  const performance = await computePerformance(userId, plan, periodStart, refresh);

  // Peer benchmarking folds into THIS report (its own weekly ingest ran Sunday);
  // it shares this delivery slot rather than being a separate proactive stream.
  const peers = await computePeerComparison(
    userId,
    { baseline: performance.analysis.baseline.median, periodMedian: performance.analysis.period.median },
    periodStart,
  ).catch((err) => {
    console.error("peer comparison failed; report proceeds without it", err);
    return null;
  });

  const goal = await queryOne<{ detail: string }>(
    `SELECT detail FROM goals WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );

  const res = await llmCall({
    userId,
    eventType: "progress_report",
    tier: progressReport.tier,
    system: progressReport.system,
    user: progressReport.render({
      throughline: plan.throughline,
      goal: goal?.detail ?? "(not set)",
      developed: plan.unlock.filter((u) => u.status === "developed").map((u) => u.idea),
      stalled: plan.unlock.filter((u) => u.status === "pending").map((u) => u.idea),
      performance: renderPerformance(performance),
      peerComparison: peers?.text ?? null,
    }),
    json: true,
    maxTokens: 800,
  });
  const { messages } = schema.parse(res.parsed);

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'progress_report', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ messages, performance })],
  );

  // Paced delivery in one window: everything but the closer as a sequence, the
  // closer via sendTelegram so it carries the reaction keyboard - plus, when
  // the period had a real outlier, an offer to repurpose that specific post
  // (acting on a measured signal; rides this message, no extra proactive send).
  if (messages.length > 1) {
    const ok = await sendTelegramSequence(userId, messages.slice(0, -1));
    if (!ok) return false;
  }
  const outlier = performance.analysis.outliers[0];
  let keyboard: InlineKeyboard | undefined;
  if (surfacing && outlier?.captureId) {
    keyboard = reactionKeyboard(surfacing.id).row().text("♻️ repurpose the outlier for LinkedIn", `rpz:c:${outlier.captureId}:li`);
  }
  return sendTelegram(userId, messages[messages.length - 1]!, surfacing?.id, keyboard);
}
