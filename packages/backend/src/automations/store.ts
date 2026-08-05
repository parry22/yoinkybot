/**
 * DB access for automations + automation_runs. Every status transition that
 * gates real work goes through `claimRun` (atomic compare-and-set), so a
 * duplicate tick, double callback tap, or redelivered job can never double-draft,
 * double-DM, or double-post.
 */
import { query, queryOne } from "../db/pool.js";
import type { Automation, AutomationRun, RunStatus } from "./types.js";

export async function listAutomations(userId: string): Promise<Automation[]> {
  return query<Automation>(`SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
}

export async function getAutomation(id: string, userId: string): Promise<Automation | null> {
  return (await queryOne<Automation>(`SELECT * FROM automations WHERE id = $1 AND user_id = $2`, [id, userId])) ?? null;
}

/** All enabled automations across all users - the cron's work list. */
export async function enabledAutomations(): Promise<Automation[]> {
  return query<Automation>(`SELECT * FROM automations WHERE enabled = true`);
}

export interface AutomationInput {
  name: string;
  source_type: Automation["source_type"];
  delivery_mode: Automation["delivery_mode"];
  platform: Automation["platform"];
  cadence_kind: Automation["cadence_kind"];
  cadence_meta?: Automation["cadence_meta"];
  respect_quiet_hours?: boolean;
  monthly_cap?: number;
  pillar_scope?: string[] | null;
  brief?: string | null;
}

export async function createAutomation(userId: string, input: AutomationInput, defaultMonthlyCap: number): Promise<Automation> {
  const row = await queryOne<Automation>(
    `INSERT INTO automations
       (user_id, profile_id, name, source_type, delivery_mode, platform, cadence_kind, cadence_meta,
        respect_quiet_hours, monthly_cap, pillar_scope, brief)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      userId,
      input.name,
      input.source_type,
      input.delivery_mode,
      input.platform,
      input.cadence_kind,
      JSON.stringify(input.cadence_meta ?? {}),
      input.respect_quiet_hours ?? true,
      input.monthly_cap ?? defaultMonthlyCap,
      input.pillar_scope ? JSON.stringify(input.pillar_scope) : null,
      input.brief?.trim() || null,
    ],
  );
  return row!;
}

export async function updateAutomation(id: string, userId: string, input: AutomationInput): Promise<Automation | null> {
  return (
    (await queryOne<Automation>(
      `UPDATE automations SET name=$3, source_type=$4, delivery_mode=$5, platform=$6, cadence_kind=$7,
         cadence_meta=$8, respect_quiet_hours=$9, monthly_cap=$10, pillar_scope=$11, brief=$12, updated_at=now()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [
        id,
        userId,
        input.name,
        input.source_type,
        input.delivery_mode,
        input.platform,
        input.cadence_kind,
        JSON.stringify(input.cadence_meta ?? {}),
        input.respect_quiet_hours ?? true,
        input.monthly_cap ?? 30,
        input.pillar_scope ? JSON.stringify(input.pillar_scope) : null,
        input.brief?.trim() || null,
      ],
    )) ?? null
  );
}

export async function setEnabled(id: string, userId: string, enabled: boolean): Promise<void> {
  await query(`UPDATE automations SET enabled=$3, updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId, enabled]);
}

export async function stampRun(id: string): Promise<void> {
  await query(`UPDATE automations SET last_run_at=now(), updated_at=now() WHERE id=$1`, [id]);
}

export async function bumpWarmup(id: string): Promise<void> {
  await query(`UPDATE automations SET warmup_count = warmup_count + 1, updated_at=now() WHERE id=$1`, [id]);
}

// ── caps (counted from automation_runs; a "post" = a run that reached delivery) ──
//
// 'awaiting_approval' counts on purpose: the agent did the work and spent the
// model call, so it is a produced post whether or not the user has answered yet.
// What makes that safe is that an unanswered approval now EXPIRES (see
// expireStaleApprovals) into a status outside this set, handing the quota back.
// Before the reaper existed, five ignored DMs permanently consumed a Growth
// user's whole monthly Auto Agent allowance.
const DELIVERED_STATUSES = "('awaiting_approval','approved','scheduled','posted')";

/** Posts this automation has produced this calendar month (monthly_cap gate). */
export async function monthlyRunCount(automationId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM automation_runs
     WHERE automation_id = $1 AND status IN ${DELIVERED_STATUSES}
       AND created_at >= date_trunc('month', now())`,
    [automationId],
  );
  return Number(row?.n ?? 0);
}

/** Posts across ALL a user's automations this calendar month - the PLAN-level Auto
 *  Agent ceiling (`entitlements.automationPostsPerMonth`: Growth 5, Scale 90). */
export async function userMonthlyRunCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM automation_runs
     WHERE user_id = $1 AND status IN ${DELIVERED_STATUSES}
       AND created_at >= date_trunc('month', now())`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

/** Posts across ALL a user's automations today (global daily flood cap). */
export async function userDailyRunCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM automation_runs
     WHERE user_id = $1 AND status IN ${DELIVERED_STATUSES}
       AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

// ── runs ──
export async function createRun(
  automationId: string,
  userId: string,
  status: RunStatus,
  fields: Partial<Pick<AutomationRun, "source_ref" | "draft_body" | "media_suggestion" | "agent_steps" | "verdict_reason" | "scheduled_post_id">> = {},
): Promise<AutomationRun> {
  const row = await queryOne<AutomationRun>(
    `INSERT INTO automation_runs
       (automation_id, user_id, status, source_ref, draft_body, media_suggestion, agent_steps, verdict_reason, scheduled_post_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      automationId,
      userId,
      status,
      fields.source_ref ? JSON.stringify(fields.source_ref) : null,
      fields.draft_body ?? null,
      fields.media_suggestion ?? null,
      fields.agent_steps ? JSON.stringify(fields.agent_steps) : null,
      fields.verdict_reason ?? null,
      fields.scheduled_post_id ?? null,
    ],
  );
  return row!;
}

/** Atomic compare-and-set on status. Returns the row only if it was in `expected`. */
export async function claimRun(runId: string, expected: RunStatus, next: RunStatus): Promise<AutomationRun | null> {
  return (
    (await queryOne<AutomationRun>(
      `UPDATE automation_runs SET status=$3, updated_at=now() WHERE id=$1 AND status=$2 RETURNING *`,
      [runId, expected, next],
    )) ?? null
  );
}

export async function getRun(runId: string, userId: string): Promise<AutomationRun | null> {
  return (
    (await queryOne<AutomationRun>(`SELECT * FROM automation_runs WHERE id=$1 AND user_id=$2`, [runId, userId])) ?? null
  );
}

export async function platformForRun(runId: string, userId: string): Promise<Automation["platform"] | null> {
  const row = await queryOne<{ platform: Automation["platform"] }>(
    `SELECT a.platform FROM automation_runs r
     JOIN automations a ON a.id = r.automation_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [runId, userId],
  );
  return row?.platform ?? null;
}

export async function updateRunDraft(runId: string, draftBody: string): Promise<void> {
  await query(`UPDATE automation_runs SET draft_body=$2, edit_count=edit_count+1, updated_at=now() WHERE id=$1`, [
    runId,
    draftBody,
  ]);
}

export async function setRunScheduled(runId: string, scheduledPostId: string): Promise<void> {
  await query(`UPDATE automation_runs SET scheduled_post_id=$2, status='scheduled', updated_at=now() WHERE id=$1`, [
    runId,
    scheduledPostId,
  ]);
}

/** An approval that aged out, with the context needed to tell the user why. */
export interface ExpiredApproval {
  id: string;
  user_id: string;
  automation_name: string;
  draft_body: string | null;
}

/**
 * Age out approvals nobody answered. Fleet-wide, one statement, called from the
 * automation tick - no new queue for something this cheap.
 *
 * WHY THIS HAS TO EXIST. `awaiting_approval` counts against
 * entitlements.automationPostsPerMonth (Growth = 5) and `stampRun` has already
 * fired, so the automation produces a fresh approval the next day regardless.
 * With no expiry, a user who ignored five approval DMs had their Auto Agent
 * silently dead until the calendar month rolled over, the cap held by five
 * drafts they were never going to act on, and nothing anywhere said so.
 *
 * The transition is a compare-and-set on `status` inside the UPDATE, so it can
 * never race the user tapping approve/reject at the same moment: whichever
 * statement lands first wins and the other matches no row.
 */
export async function expireStaleApprovals(maxAgeHours: number): Promise<ExpiredApproval[]> {
  return query<ExpiredApproval>(
    `UPDATE automation_runs r
        SET status = 'expired',
            verdict_reason = $2,
            updated_at = now()
       FROM automations a
      WHERE a.id = r.automation_id
        AND r.status = 'awaiting_approval'
        AND r.created_at < now() - make_interval(hours => $1::int)
      RETURNING r.id, r.user_id, a.name AS automation_name, r.draft_body`,
    [maxAgeHours, `expired unanswered after ${maxAgeHours}h - the monthly Auto Agent slot was released`],
  );
}

export async function setRunStatus(runId: string, status: RunStatus, reason?: string): Promise<void> {
  await query(`UPDATE automation_runs SET status=$2, verdict_reason=COALESCE($3, verdict_reason), updated_at=now() WHERE id=$1`, [
    runId,
    status,
    reason ?? null,
  ]);
}
