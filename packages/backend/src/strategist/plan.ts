import { z } from "zod";
import { query, queryOne, toVector, withTransaction } from "../db/pool.js";
import { embed, embedOne } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { planPrompt } from "../prompts/plan.v1.js";
import { planV2 } from "../prompts/plan.v2.js";
import { currentDiagnosis } from "./diagnosis.js";
import { activeGoals } from "./goals.js";
import { setStage } from "./state.js";
import { profileSummaryForPrompt, type BrandProfile } from "./profile.js";
import { track, identify } from "../analytics/posthog.js";

const planSchema = z.object({
  throughline: z.string(),
  unlock_list: z.array(z.object({ idea: z.string(), rationale: z.string().default(""), priority: z.number().default(1) })),
  outside_in: z.string().default(""),
});

const planV2Schema = z.object({
  repositioning: z.string(),
  throughline: z.string(),
  months: z.array(z.object({ label: z.string(), objective: z.string() })).default([]),
  unlock_list: z.array(z.object({ idea: z.string(), rationale: z.string().default(""), priority: z.number().default(1) })),
  outside_in: z.string().default(""),
});

export interface ThreeMonthPlan {
  planId: string;
  repositioning: string;
  throughline: string;
  months: Array<{ label: string; objective: string }>;
  unlock: Array<{ idea: string; rationale: string }>;
  perWeek: number;
}

export interface PlanView {
  id: string;
  throughline: string;
  outside_in: string;
  cadence: { perWeek?: number; note?: string };
  status: string;
  unlock: Array<{ id: string; idea: string; rationale: string; priority: number; status: string }>;
}

/**
 * Generate the draft plan (throughline + unlock list + outside-in) from the
 * diagnosis and stated goal, persist it as a draft, then move into cadence
 * elicitation. Returns the cadence question to ask the user.
 */
export async function generatePlanDraft(userId: string): Promise<string> {
  const diag = await currentDiagnosis(userId);
  const goals = await activeGoals(userId);
  if (!diag) {
    await setStage(userId, "diagnosed");
    return "I need to finish your diagnosis before I can build the plan - give me a moment and try again.";
  }

  const d = diag.dimensions;
  const res = await llmCall({
    userId,
    eventType: "plan",
    tier: planPrompt.tier,
    system: planPrompt.system,
    user: planPrompt.render({
      headline: d.headline,
      fingerprint: d.intellectual_fingerprint.read,
      ownedPositions: d.intellectual_fingerprint.owned_positions,
      unsaidPatterns: d.unsaid_patterns,
      goals: goals.map((g) => ({ goal_type: g.goal_type, detail: g.detail, timeframe: g.timeframe, success: g.definition_of_success })),
    }),
    json: true,
    maxTokens: 1500,
  });
  const parsed = planSchema.parse(res.parsed);

  // Supersede any prior draft, then insert the fresh draft plan.
  await query(`UPDATE brand_plans SET status = 'superseded' WHERE user_id = $1 AND status = 'draft'`, [userId]);
  const diagId = await queryOne<{ id: string }>(
    `SELECT id FROM brand_diagnoses WHERE user_id = $1 ORDER BY version DESC LIMIT 1`,
    [userId],
  );
  const plan = await queryOne<{ id: string }>(
    `INSERT INTO brand_plans (user_id, diagnosis_id, throughline, outside_in, status)
     VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
    [userId, diagId?.id ?? null, parsed.throughline, parsed.outside_in],
  );

  // Store unlock items with embeddings (used by plan-aware resurfacing later).
  const sorted = [...parsed.unlock_list].sort((a, b) => a.priority - b.priority).slice(0, 5);
  if (sorted.length) {
    const embeddings = await embed(sorted.map((u) => u.idea), userId);
    for (let i = 0; i < sorted.length; i++) {
      const u = sorted[i]!;
      await query(
        `INSERT INTO unlock_items (user_id, plan_id, idea, rationale, priority, embedding)
         VALUES ($1,$2,$3,$4,$5,$6::vector)`,
        [userId, plan!.id, u.idea, u.rationale, i + 1, toVector(embeddings[i]!)],
      );
    }
  }

  return "I've built your plan. One thing I won't assume: realistically, how many posts a week can you commit to? Give me an honest number, not an aspirational one.";
}

/**
 * Stage 11: generate the three-month plan for a profile-first user, grounded in
 * their diagnosis, stated profile, and the measured gap. Persists the durable
 * plan primitives (throughline, unlock items, outside-in, cadence-from-capacity)
 * plus the repositioning statement + month-by-month roadmap. Returns the shaped
 * plan for the paced reveal; null if there's no diagnosis to build on.
 */
export async function generateThreeMonthPlan(
  userId: string,
  profile: BrandProfile,
  gapText: string,
): Promise<ThreeMonthPlan | null> {
  const diag = await currentDiagnosis(userId);
  if (!diag) return null;
  const d = diag.dimensions;

  const res = await llmCall({
    userId,
    eventType: "plan",
    tier: planV2.tier,
    system: planV2.system,
    user: planV2.render({
      headline: d.headline,
      fingerprint: d.intellectual_fingerprint.read,
      ownedPositions: d.intellectual_fingerprint.owned_positions,
      unsaidPatterns: d.unsaid_patterns,
      profileSummary: profileSummaryForPrompt(profile),
      gapSummary: gapText || "(gap summary unavailable)",
      primaryGoal: profile.primary_goal,
      postingCapacity: profile.posting_capacity,
    }),
    json: true,
    maxTokens: 1800,
  });
  const parsed = planV2Schema.parse(res.parsed);
  const perWeek = profile.posting_capacity && profile.posting_capacity > 0 ? profile.posting_capacity : 3;

  await query(`UPDATE brand_plans SET status = 'superseded' WHERE user_id = $1 AND status = 'draft'`, [userId]);
  const plan = await queryOne<{ id: string }>(
    `INSERT INTO brand_plans (user_id, diagnosis_id, throughline, outside_in, cadence, roadmap, status)
     VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING id`,
    [
      userId,
      diag.id,
      parsed.throughline,
      parsed.outside_in,
      JSON.stringify({ perWeek, note: "from stated capacity" }),
      JSON.stringify({ repositioning: parsed.repositioning, months: parsed.months }),
    ],
  );

  const sorted = [...parsed.unlock_list].sort((a, b) => a.priority - b.priority).slice(0, 5);
  if (sorted.length) {
    const embeddings = await embed(sorted.map((u) => u.idea), userId);
    for (let i = 0; i < sorted.length; i++) {
      const u = sorted[i]!;
      await query(
        `INSERT INTO unlock_items (user_id, plan_id, idea, rationale, priority, embedding)
         VALUES ($1,$2,$3,$4,$5,$6::vector)`,
        [userId, plan!.id, u.idea, u.rationale, i + 1, toVector(embeddings[i]!)],
      );
    }
  }

  return {
    planId: plan!.id,
    repositioning: parsed.repositioning,
    throughline: parsed.throughline,
    months: parsed.months,
    unlock: sorted.map((u) => ({ idea: u.idea, rationale: u.rationale })),
    perWeek,
  };
}

export async function confirmPlan(userId: string, planId: string): Promise<boolean> {
  // All four mutations are one transaction so a mid-way failure can't leave the
  // plan active while the stage/state say otherwise (adversarial-review finding).
  const confirmed = await withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE brand_plans SET status = 'active', confirmed_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'draft' RETURNING id`,
      [planId, userId],
    );
    if (res.rowCount === 0) return false;
    await client.query(`UPDATE brand_plans SET status = 'superseded' WHERE user_id = $1 AND status = 'active' AND id <> $2`, [
      userId,
      planId,
    ]);
    await client.query(`UPDATE users SET strategist_stage = 'plan_active', strategist_state = '{}'::jsonb WHERE id = $1`, [userId]);
    return true;
  });
  // Activation: the full onboarding arc (profile → connect → diagnosis → plan)
  // is done and the user is now in steady state.
  if (confirmed) {
    identify(userId, { stage: "plan_active" });
    track(userId, "onboarding_completed", {});
  }
  return confirmed;
}

export function parseCadence(text: string): number {
  const m = text.match(/(\d+)/);
  const n = m ? Number(m[1]) : 3;
  if (/day|daily/i.test(text) && n <= 7) return Math.min(7, n * (/\bper day|a day|daily\b/i.test(text) ? 7 : 1));
  return Math.max(0, Math.min(14, n));
}

/** Set a draft plan's cadence without the button-flow presentation (used by the session machine). */
export async function setPlanCadence(
  userId: string,
  planId: string,
  input: { perWeek?: number; note?: string },
): Promise<void> {
  const perWeek = input.perWeek ?? (input.note ? parseCadence(input.note) : 3);
  await query(`UPDATE brand_plans SET cadence = $2 WHERE id = $1 AND user_id = $3`, [
    planId,
    JSON.stringify({ perWeek, note: input.note ?? null }),
    userId,
  ]);
}

export async function getPlan(userId: string, planId?: string): Promise<PlanView | null> {
  const plan = await queryOne<{ id: string; throughline: string; outside_in: string; cadence: PlanView["cadence"]; status: string }>(
    planId
      ? `SELECT id, throughline, outside_in, cadence, status FROM brand_plans WHERE id = $1 AND user_id = $2`
      : // Prefer the active plan; fall back to the latest draft (so the confirm UI can show it).
        `SELECT id, throughline, outside_in, cadence, status FROM brand_plans
         WHERE user_id = $1 AND status IN ('active','draft')
         ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`,
    planId ? [planId, userId] : [userId],
  );
  if (!plan) return null;
  const unlock = await query<{ id: string; idea: string; rationale: string; priority: number; status: string }>(
    `SELECT id, idea, rationale, priority, status FROM unlock_items WHERE plan_id = $1 ORDER BY priority`,
    [plan.id],
  );
  return { ...plan, unlock };
}

/**
 * When the user drafts/publishes something, mark the closest pending unlock item
 * as developed so the proactive engine stops pushing it and progress reports are
 * accurate. No-op if nothing is close enough or the user has no active plan.
 */
export async function markUnlockDeveloped(userId: string, draftText: string, memoryId?: string): Promise<void> {
  const pending = await queryOne<{ id: string; distance: number }>(
    `SELECT id, (embedding <=> $2::vector) AS distance
     FROM unlock_items
     WHERE user_id = $1 AND status = 'pending' AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector LIMIT 1`,
    [userId, toVector(await embedOne(draftText, userId))],
  );
  if (pending && pending.distance < 0.5) {
    await query(
      `UPDATE unlock_items SET status = 'developed', developed_at = now(), memory_id = COALESCE($2, memory_id) WHERE id = $1`,
      [pending.id, memoryId ?? null],
    );
  }
}

/** The top pending unlock item for plan-aware resurfacing (null if none/no plan). */
export async function topPendingUnlock(
  userId: string,
): Promise<{ id: string; idea: string; rationale: string } | null> {
  const row = await queryOne<{ id: string; idea: string; rationale: string }>(
    `SELECT ui.id, ui.idea, ui.rationale FROM unlock_items ui
     JOIN brand_plans bp ON bp.id = ui.plan_id AND bp.status = 'active'
     WHERE ui.user_id = $1 AND ui.status = 'pending'
     ORDER BY ui.priority LIMIT 1`,
    [userId],
  );
  return row ?? null;
}

export function formatPlan(p: PlanView): string {
  const unlock = p.unlock.map((u, i) => `${i + 1}. ${u.idea}\n   → ${u.rationale}`).join("\n");
  return (
    `Here's your plan:\n\n` +
    `🎯 *Throughline* - what you should become known for:\n${p.throughline}\n\n` +
    `🔓 *Unlock list* - in order of impact:\n${unlock}\n\n` +
    `🌍 *Outside-in* - what I'll watch for and bring you:\n${p.outside_in}\n\n` +
    `🗓 *Cadence*: ${p.cadence.perWeek ?? "?"}/week\n\n` +
    `Commit to this and I'll start working it - prioritizing these unlocks, checking your drafts against the throughline, and surfacing the right moments.`
  );
}
