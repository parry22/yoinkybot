import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { query, queryOne } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { weeklyPlan } from "../prompts/weekly-plan.v1.js";
import { getPlan } from "../strategist/plan.js";
import { createIdeaMoment } from "./offer-angles.js";
import { sendTelegram } from "../telegram/bot.js";

const schema = z.object({ message: z.string().min(1) });

/**
 * Monday working rhythm: propose THIS week's specific posts from the unlock
 * list, sized to committed cadence. Plan-driven service like the progress
 * report - its own weekly gate, outside the shared proactive budget. Every
 * ingredient (unlocks, angles, cadence) already exists; this is the retained-
 * agency move of actually opening the week with them.
 */
export async function handleWeeklyPlan(): Promise<void> {
  const users = await query<{ user_id: string }>(
    `SELECT bp.user_id FROM brand_plans bp
     JOIN users u ON u.id = bp.user_id
     WHERE bp.status = 'active' AND u.telegram_id IS NOT NULL`,
  );
  for (const { user_id } of users) {
    try {
      await maybeWeeklyPlan(user_id);
    } catch (err) {
      console.error(`weekly plan failed for ${user_id}`, err);
    }
  }
}

export async function maybeWeeklyPlan(userId: string): Promise<boolean> {
  const recent = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM surfacings
     WHERE user_id = $1 AND type = 'weekly_plan' AND delivered_at > now() - interval '6 days'`,
    [userId],
  );
  if (Number(recent?.n ?? 0) > 0) return false;

  const plan = await getPlan(userId);
  if (!plan || plan.status !== "active") return false;
  const pending = plan.unlock.filter((u) => u.status === "pending").slice(0, 2);
  if (pending.length === 0) return false; // nothing left to propose - the progress report handles that story

  const pendingAngles = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM surfacings
     WHERE user_id = $1 AND type IN ('angle_offer','trend_match') AND user_reaction IS NULL
       AND delivered_at > now() - interval '7 days'`,
    [userId],
  );

  const res = await llmCall({
    userId,
    eventType: "weekly_plan",
    tier: weeklyPlan.tier,
    system: weeklyPlan.system,
    user: weeklyPlan.render({
      throughline: plan.throughline,
      perWeek: plan.cadence?.perWeek ?? 2,
      unlocks: pending.map((u) => ({ idea: u.idea, rationale: u.rationale })),
      outsideIn: plan.outside_in,
      pendingAngleCount: Number(pendingAngles?.n ?? 0),
    }),
    json: true,
    maxTokens: 350,
  });
  const { message } = schema.parse(res.parsed);

  await queryOne(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'weekly_plan', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ message, unlock_ids: pending.map((u) => u.id) })],
  );

  // One tap from proposal to angles, reusing the existing mkang flow.
  const kb = new InlineKeyboard();
  for (let i = 0; i < pending.length; i++) {
    const momentId = await createIdeaMoment(userId, pending[i]!.idea, `${pending[i]!.idea}\n\n${pending[i]!.rationale}`);
    if (momentId) kb.text(`✍️ angles for #${i + 1}`, `mkang:${momentId}`).row();
  }
  return sendTelegram(userId, message, undefined, kb);
}
