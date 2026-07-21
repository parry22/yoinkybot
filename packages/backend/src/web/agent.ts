/**
 * "Agent mode" for the web app: on a tick (or on demand) it does the whole loop
 * on the user's behalf - pick a topic from their own unlock backlog, draft it in
 * their voice, and SCHEDULE it at a sensible slot. Scheduled (not instantly
 * posted) on purpose: it lands in the queue where the user can see and cancel it
 * before it fires via the normal scheduled-post worker. "Analyse best posts" is
 * served by the analytics module (top posts by impressions).
 */
import type { User } from "../lib/auth.js";
import { query, queryOne } from "../db/pool.js";
import { topPendingUnlock, markUnlockDeveloped } from "../strategist/plan.js";
import { generateDraft } from "../drafting/draft.js";
import { schedulePost, listScheduled } from "../scheduling/service.js";
import { ensureBoss } from "../jobs/boss.js";

/** How far ahead the agent schedules its next post (leaves a review window). */
const SCHEDULE_AHEAD_MS = 20 * 60 * 60 * 1000;
/** Minimum gap between agent cycles for one user (once/day-ish). */
const MIN_CYCLE_GAP_MS = 20 * 60 * 60 * 1000;

export async function getAgentEnabled(userId: string): Promise<boolean> {
  const row = await queryOne<{ on: boolean | null }>(
    `SELECT (settings->>'agent_mode')::boolean AS on FROM users WHERE id = $1`,
    [userId],
  );
  return Boolean(row?.on);
}

export async function setAgentEnabled(userId: string, on: boolean): Promise<void> {
  await query(
    `UPDATE users SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{agent_mode}', $2::jsonb, true) WHERE id = $1`,
    [userId, JSON.stringify(on)],
  );
}

async function lastRunMs(userId: string): Promise<number> {
  const row = await queryOne<{ ts: string | null }>(
    `SELECT settings->>'agent_last_run' AS ts FROM users WHERE id = $1`,
    [userId],
  );
  const t = row?.ts ? Number(row.ts) : 0;
  return Number.isFinite(t) ? t : 0;
}

async function stampRun(userId: string, ts: number): Promise<void> {
  await query(
    `UPDATE users SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{agent_last_run}', $2::jsonb, true) WHERE id = $1`,
    [userId, JSON.stringify(String(ts))],
  );
}

export interface AgentCycleResult {
  ok: boolean;
  message: string;
  action?: { topic: string; content: string; platform: "x"; scheduledFor: string };
}

/** One full agent cycle: topic → draft → schedule. */
export async function runAgentCycle(user: User): Promise<AgentCycleResult> {
  await ensureBoss();

  const topic = await topPendingUnlock(user.id);
  if (!topic) {
    return {
      ok: false,
      message:
        "no fresh topic in your backlog yet - drop a few thoughts or connect your X so i've got real material to work from.",
    };
  }

  const draft = await generateDraft(user.id, topic.idea, "x");
  if (!draft.ok || !draft.draft) {
    return { ok: false, message: draft.note || "couldn't draft that one right now." };
  }

  const scheduledFor = new Date(Date.now() + SCHEDULE_AHEAD_MS);
  const res = await schedulePost(user.id, { platform: "x", content: draft.draft, scheduledFor });
  if (!res.ok) {
    return { ok: false, message: res.reason ?? "couldn't schedule that." };
  }

  // Don't develop the same idea twice.
  await markUnlockDeveloped(user.id, draft.draft).catch(() => {});
  await stampRun(user.id, Date.now());

  return {
    ok: true,
    message: `scheduled a post for ${scheduledFor.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    action: { topic: topic.idea, content: draft.draft, platform: "x", scheduledFor: scheduledFor.toISOString() },
  };
}

export interface AgentState {
  enabled: boolean;
  scheduled: Array<{ id: string; platform: string; content: string; scheduledFor: string }>;
}

export async function getAgentState(userId: string): Promise<AgentState> {
  const [enabled, posts] = await Promise.all([getAgentEnabled(userId), listScheduled(userId).catch(() => [])]);
  return {
    enabled,
    scheduled: posts.map((p) => ({
      id: p.id,
      platform: p.platform,
      content: p.content,
      scheduledFor: p.scheduled_for,
    })),
  };
}

/** Cron entry: run a cycle for every agent-mode user that's due. */
export async function handleAgentTick(): Promise<void> {
  const users = await query<{ id: string; telegram_id: string | null; email: string | null; settings: Record<string, unknown>; created_at: string }>(
    `SELECT id, telegram_id, email, settings, created_at::text FROM users WHERE (settings->>'agent_mode')::boolean IS TRUE`,
  );
  const now = Date.now();
  for (const u of users) {
    try {
      if (now - (await lastRunMs(u.id)) < MIN_CYCLE_GAP_MS) continue;
      await runAgentCycle(u as unknown as User);
    } catch (err) {
      console.error(`agent tick failed for ${u.id}`, err);
    }
  }
}
