import { InlineKeyboard } from "grammy";
import { query, queryOne } from "../db/pool.js";
import { sendTelegram } from "../telegram/bot.js";
import { VOICE_MIN_MEMORIES } from "../voice/profile.js";
import { PROACTIVE_TYPES } from "./cadence.js";

/**
 * The proactive engine's fallback outcomes for the early, sparse-data window:
 * the cold-start first touch (mandatory presence right after a plan goes live)
 * and structural nudges (places the user has stalled where a sentence from the
 * strategist beats waiting for them to remember a command exists).
 *
 * Decisions here are pure functions (unit-tested); only the maybe* wrappers
 * touch the DB and Telegram. Everything delivered logs as a 'nudge' surfacing
 * so it shares the unified proactive budget and shows up in history.
 */

// ── Cold start ───────────────────────────────────────────────────────────────

/**
 * Hours of total silence after plan confirmation before the first touch fires.
 * The spec's window is 48h of zero contact; we fire at 24h so the first-ever
 * proactive message lands on day two, not day three - this window is where
 * "is this thing even on?" gets decided.
 */
export const COLD_START_MIN_HOURS = 24;

export interface ColdStartInputs {
  /** brand_plans.confirmed_at of the active plan, epoch ms; null = no active plan. */
  planConfirmedAt: number | null;
  /** Proactive deliveries of ANY kind since confirmation. */
  proactiveSinceConfirm: number;
  now: number;
}

/** True when the mandatory first touch should fire (budget-exempt). */
export function decideColdStart(i: ColdStartInputs): boolean {
  if (i.planConfirmedAt === null) return false;
  if (i.proactiveSinceConfirm > 0) return false;
  return i.now - i.planConfirmedAt >= COLD_START_MIN_HOURS * 60 * 60 * 1000;
}

/** Gather the cold-start inputs for a user (active plan + deliveries since). */
export async function coldStartInputs(userId: string, now = Date.now()): Promise<ColdStartInputs> {
  const plan = await queryOne<{ confirmed_at: string | null }>(
    `SELECT confirmed_at::text FROM brand_plans
     WHERE user_id = $1 AND status = 'active' ORDER BY confirmed_at DESC LIMIT 1`,
    [userId],
  );
  if (!plan?.confirmed_at) return { planConfirmedAt: null, proactiveSinceConfirm: 0, now };
  const confirmedAt = new Date(plan.confirmed_at).getTime();
  const delivered = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM surfacings
     WHERE user_id = $1 AND type = ANY($2) AND delivered_at > $3`,
    [userId, PROACTIVE_TYPES, new Date(confirmedAt)],
  );
  return { planConfirmedAt: confirmedAt, proactiveSinceConfirm: Number(delivered?.n ?? 0), now };
}

/**
 * The honest check-in - the cold-start ladder's last rung, when memory is too
 * sparse for even a relaxed resurface. A modest real message beats an empty
 * inbox that makes the whole product feel dead.
 */
export async function sendColdStartCheckin(userId: string): Promise<boolean> {
  const plan = await queryOne<{ throughline: string }>(
    `SELECT throughline FROM brand_plans WHERE user_id = $1 AND status = 'active' ORDER BY confirmed_at DESC LIMIT 1`,
    [userId],
  );
  const message = plan
    ? `Your plan's been live for a day and I've been sitting with it. Quick pulse check: how do the first days feel on your side? If "${plan.throughline.slice(0, 120)}" is already chafing anywhere, say so now. It's cheap to adjust today and expensive in a month.`
    : `We set things up and then it went quiet on my side, which is on me. How have the first days felt? Anything you've been thinking about that we should turn into the first post?`;
  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'nudge', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ kind: "cold_start", message })],
  );
  return sendTelegram(userId, message, surfacing?.id);
}

// ── Structural nudges ────────────────────────────────────────────────────────

export type NudgeKind = "profile_stall" | "connect_stall" | "voice" | "goals_stall" | "shipping_stall";

/** Don't repeat the same nudge inside this window. */
export const NUDGE_DEDUP_DAYS = 10;

/** Idle time before nudging a dropped-off onboarding, in hours. */
export const PROFILE_STALL_HOURS = 20;
export const CONNECT_STALL_HOURS = 24;

export interface NudgeInputs {
  memoryCount: number;
  hasVoiceProfile: boolean;
  stage: string;
  /** Days since the latest diagnosis; Infinity when none exists. */
  diagnosisAgeDays: number;
  hasGoals: boolean;
  planActive: boolean;
  planAgeDays: number;
  cadencePerWeek: number;
  draftsLast14d: number;
  daysSinceProgressReport: number;
  /** Onboarding drop-off signals. */
  onboardingIdleHours: number;
  hasConnectedAccount: boolean;
  statedNiche: string | null;
  /** Kinds nudged within the dedup window. */
  recentNudgeKinds: NudgeKind[];
}

/**
 * Pick the one structural nudge worth sending, or null. Onboarding drop-offs come
 * first (a stalled intake or an un-connected finished profile is the costliest
 * place to lose someone), then the voice threshold, then diagnosis→goals, then a
 * stalled shipping cadence.
 */
export function pickNudge(i: NudgeInputs): NudgeKind | null {
  const recent = new Set(i.recentNudgeKinds);
  // Dropped off mid-intake (Stages 1-7): a follow-up beats silence.
  if (!recent.has("profile_stall") && i.stage === "profiling" && i.onboardingIdleHours >= PROFILE_STALL_HOURS) {
    return "profile_stall";
  }
  // Finished the profile but never connected an account (Stage 8 stall).
  if (
    !recent.has("connect_stall") &&
    i.stage === "profile_set" &&
    !i.hasConnectedAccount &&
    i.onboardingIdleHours >= CONNECT_STALL_HOURS
  ) {
    return "connect_stall";
  }
  if (!recent.has("voice") && i.memoryCount >= VOICE_MIN_MEMORIES && !i.hasVoiceProfile) return "voice";
  if (!recent.has("goals_stall") && i.stage === "diagnosed" && i.diagnosisAgeDays >= 3 && !i.hasGoals) {
    return "goals_stall";
  }
  if (
    !recent.has("shipping_stall") &&
    i.planActive &&
    i.planAgeDays >= 14 &&
    i.cadencePerWeek > 0 &&
    i.draftsLast14d === 0 &&
    i.daysSinceProgressReport >= 7
  ) {
    return "shipping_stall";
  }
  return null;
}

async function gatherNudgeInputs(userId: string): Promise<NudgeInputs> {
  const row = await queryOne<{
    memory_count: string;
    has_voice: boolean;
    stage: string;
    diagnosis_at: string | null;
    goal_count: string;
    plan_confirmed_at: string | null;
    cadence_per_week: string | null;
    drafts_14d: string;
    last_progress_at: string | null;
    has_account: boolean;
    last_activity: string | null;
    stated_niche: string | null;
  }>(
    `SELECT
       (SELECT count(*) FROM memories WHERE user_id = $1 AND status = 'active')::text AS memory_count,
       EXISTS(SELECT 1 FROM voice_profiles WHERE user_id = $1) AS has_voice,
       (SELECT strategist_stage FROM users WHERE id = $1) AS stage,
       (SELECT max(created_at)::text FROM brand_diagnoses WHERE user_id = $1) AS diagnosis_at,
       (SELECT count(*) FROM goals WHERE user_id = $1 AND status = 'active')::text AS goal_count,
       (SELECT confirmed_at::text FROM brand_plans WHERE user_id = $1 AND status = 'active' ORDER BY confirmed_at DESC LIMIT 1) AS plan_confirmed_at,
       (SELECT cadence->>'perWeek' FROM brand_plans WHERE user_id = $1 AND status = 'active' ORDER BY confirmed_at DESC LIMIT 1) AS cadence_per_week,
       (SELECT count(*) FROM drafts WHERE user_id = $1 AND created_at > now() - interval '14 days')::text AS drafts_14d,
       (SELECT max(delivered_at)::text FROM surfacings WHERE user_id = $1 AND type = 'progress_report') AS last_progress_at,
       EXISTS(SELECT 1 FROM connected_accounts WHERE user_id = $1) AS has_account,
       (SELECT max(created_at)::text FROM chat_messages WHERE user_id = $1) AS last_activity,
       (SELECT niche FROM brand_profiles WHERE user_id = $1) AS stated_niche`,
    [userId],
  );
  const recent = await query<{ kind: NudgeKind }>(
    `SELECT payload->>'kind' AS kind FROM surfacings
     WHERE user_id = $1 AND type = 'nudge' AND delivered_at > now() - make_interval(days => $2)`,
    [userId, NUDGE_DEDUP_DAYS],
  );
  const DAY = 86_400_000;
  const now = Date.now();
  return {
    memoryCount: Number(row?.memory_count ?? 0),
    hasVoiceProfile: row?.has_voice ?? false,
    stage: row?.stage ?? "new",
    diagnosisAgeDays: row?.diagnosis_at ? (now - new Date(row.diagnosis_at).getTime()) / DAY : Infinity,
    hasGoals: Number(row?.goal_count ?? 0) > 0,
    planActive: !!row?.plan_confirmed_at,
    planAgeDays: row?.plan_confirmed_at ? (now - new Date(row.plan_confirmed_at).getTime()) / DAY : 0,
    cadencePerWeek: Number(row?.cadence_per_week ?? 0),
    draftsLast14d: Number(row?.drafts_14d ?? 0),
    daysSinceProgressReport: row?.last_progress_at ? (now - new Date(row.last_progress_at).getTime()) / DAY : Infinity,
    onboardingIdleHours: row?.last_activity ? (now - new Date(row.last_activity).getTime()) / 3_600_000 : Infinity,
    hasConnectedAccount: row?.has_account ?? false,
    statedNiche: row?.stated_niche ?? null,
    recentNudgeKinds: recent.map((r) => r.kind).filter(Boolean),
  };
}

const NUDGE_MESSAGES: Record<NudgeKind, (i: NudgeInputs) => { text: string; keyboard?: InlineKeyboard }> = {
  profile_stall: (i) => ({
    text: i.statedNiche
      ? `We were partway through setting you up, you'd started telling me about ${i.statedNiche}, and then it went quiet. Still keen to see where you actually stand? Pick up whenever, I just need a few more answers.`
      : `We started setting up your profile and then it went quiet. No rush, but I only need a few more answers before I can read your history and show you the gap. Want to pick up?`,
  }),
  connect_stall: () => ({
    text:
      `You built the whole profile, that's the hard part done. One step left: drop your X handle (like @yourname) or your LinkedIn profile URL and I'll read your actual history and show you exactly where you stand against it.`,
  }),
  voice: (i) => ({
    text:
      `You're past ${VOICE_MIN_MEMORIES} memories now. That's enough signal for me to build your voice profile, ` +
      `the thing that makes every draft sound like you instead of a template. Want me to build it?`,
    keyboard: new InlineKeyboard().text("Build my voice profile", "nudge:voice"),
  }),
  goals_stall: () => ({
    text:
      `We did the hard part a few days ago and then it went quiet. The read is only worth something once it points at a goal. ` +
      `One question, whenever you're ready: what are you actually optimizing for right now?`,
  }),
  shipping_stall: (i) => ({
    text:
      `You committed to ${i.cadencePerWeek} a week and nothing has shipped in two. Not a guilt trip, a diagnostic: ` +
      `is the cadence wrong, or is the friction somewhere else? Tell me which and we fix that part, not the whole plan.`,
  }),
};

/** The last option before "genuinely nothing": one structural nudge, deduped. */
export async function maybeStructuralNudge(userId: string): Promise<boolean> {
  const inputs = await gatherNudgeInputs(userId);
  const kind = pickNudge(inputs);
  if (!kind) return false;

  const { text, keyboard } = NUDGE_MESSAGES[kind](inputs);
  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'nudge', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ kind, message: text })],
  );
  return sendTelegram(userId, text, surfacing?.id, keyboard);
}
