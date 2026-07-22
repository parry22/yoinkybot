import { query, queryOne, withTransaction } from "../db/pool.js";
import { deletePerson } from "../analytics/posthog.js";
import type { ProfileField } from "./profile.js";

/**
 * Onboarding phases. The new profile-first arc is
 *   profiling → connect_transition → (connect + ingest) → gap_analysis → plan_build → active
 * The legacy cold arc (opening → diagnosis_dialogue → goals → plan_build) is
 * retained: it's the connect-first escape hatch and the fallback for users who
 * were mid-flow at deploy.
 */
export type SessionPhase =
  | "profiling"
  | "connect_transition"
  | "gap_analysis"
  | "opening"
  | "diagnosis_dialogue"
  | "goals"
  | "plan_build"
  | "active";

export const DIAGNOSIS_BEATS = [
  "whats_working", // lead with this
  "intellectual_fingerprint",
  "post_vs_think_gap",
  "authentic_vs_performed",
  "outside_in",
  "unsaid_patterns", // trust-gated, saved for last
] as const;
export type DiagnosisBeat = (typeof DIAGNOSIS_BEATS)[number];

/** Plan presentation, paced the same way the diagnosis reveal is: one beat per message. */
export const PLAN_BEATS = ["throughline", "unlock", "cadence"] as const;
export type PlanBeat = (typeof PLAN_BEATS)[number];

/**
 * The conversational cursor for the paced strategist session, stored in
 * users.strategist_state jsonb. Orthogonal to users.strategist_stage (the
 * durable milestone enum).
 */
/**
 * The Stage 1-7 intake cursor. `captured` is the anti-loop ledger (a field is
 * done when answered OR explicitly noted unresolved); `pushed` records fields
 * we've already pressed once on vagueness (push-once discipline); `unresolved`
 * are fields the user still couldn't answer after the push. Mirrors the
 * `covered`/`goalDraft` ledger pattern so the reducer stays pure.
 */
export interface ProfileCursor {
  captured?: ProfileField[];
  pushed?: ProfileField[];
  unresolved?: ProfileField[];
  pillarsDrafted?: string[]; // Stage 5 pillars derived in code, awaiting confirmation
  /** Consecutive turns spent on the same current field without capturing it —
   *  the anti-loop backstop force-advances once this crosses a threshold. */
  stuck?: number;
}

export interface StrategistState {
  phase?: SessionPhase;
  profile?: ProfileCursor; // the Stage 1-7 intake progress (profiling phase)
  diagnosisId?: string; // pins the diagnosis this session is grounded in
  covered?: DiagnosisBeat[]; // beats revealed so far (the anti-dump ledger)
  goalDraft?: {
    optimizing_for?: string;
    timeframe?: string;
    success?: string;
    goal_type?: string;
  };
  gapText?: string; // the computed gap block, kept from gap_analysis so the plan can reuse it
  planId?: string; // draft plan awaiting cadence/commit
  planCovered?: PlanBeat[]; // plan beats revealed so far (throughline → unlock → cadence)
  cadenceSet?: boolean; // draft plan has a cadence → ready to commit
  turnsInPhase?: number; // watchdog counter, reset on phase change
  lastTurnAt?: string;
  /** The bot just asked for a handle — the next bare "@handle" reply is the answer. */
  awaitingConnect?: boolean;
  /**
   * The OAuth-first connect sequence cursor (telegram/connect-auth.ts): which
   * platforms we've sent the auth-button offer for, and which the user tapped
   * "skip" on. X is offered first, LinkedIn once X resolves; skipping both is
   * refused until at least one account is connected (auth or typed handle).
   */
  connectFlow?: { offered?: ("x" | "linkedin")[]; skipped?: ("x" | "linkedin")[] };
  /** The Stage 4 tone inline-keyboard has been sent once (don't resend each turn). */
  toneMenuSent?: boolean;
  /** An automation approval-card "edit" was tapped — the next text turn is the
   *  edit instruction for this run (automations/approval.ts). */
  pendingAutoEdit?: { runId: string };
}

export async function getState(userId: string): Promise<StrategistState> {
  const row = await queryOne<{ strategist_state: StrategistState }>(
    `SELECT strategist_state FROM users WHERE id = $1`,
    [userId],
  );
  return row?.strategist_state ?? {};
}

export async function setState(userId: string, state: StrategistState): Promise<void> {
  await query(`UPDATE users SET strategist_state = $2 WHERE id = $1`, [userId, JSON.stringify(state)]);
}

export async function clearState(userId: string): Promise<void> {
  await setState(userId, {});
}

/**
 * Full account reset (triggered by the clear_everything chat tool, confirmed via
 * the clr:confirm button): wipe everything derived from the user's work —
 * captures, memories, positions, the diagnosis, goals, plan, chat history,
 * drafts, repurposed content, mentions/replies, peer benchmarks, usage history,
 * connected accounts — and put them back at the 'new' stage so they start the
 * connect flow over. The user row itself (Telegram identity) and their billing
 * subscription are kept. All deletes run in one transaction so a partial wipe
 * can never strand the account half-cleared. The confirmation copy promises
 * "everything", so this list must stay exhaustive.
 *
 * Child tables are deleted before their parents; deleting `memories` cascades
 * to `memory_links`, and `surfacings` cascades to any `angles` under it.
 */
export async function resetUserData(userId: string): Promise<void> {
  const tables = [
    "unlock_items",
    "angles",
    "drafts",
    "repurposed_content",
    "sent_replies", // FK → mentions; delete before it
    "mentions",
    "peer_comparison_snapshots", // FK → peer_profiles; delete before it
    "peer_profiles", // cascades peer_captures
    "automation_runs", // FK → automations; delete before it
    "automations",
    "buyer_signals", // FK → surfacings (SET NULL); delete before it anyway
    "buyer_calibration",
    "surfacings",
    "moments",
    "brand_plans",
    "brand_diagnoses",
    "brand_profiles",
    "icp_profiles",
    "goals",
    "positions",
    "clusters",
    "voice_profiles",
    "chat_messages",
    "usage_events",
    "memories", // cascades memory_links
    "captures",
    "connected_accounts",
    "telegram_messages",
  ];
  await withTransaction(async (client) => {
    for (const t of tables) {
      await client.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await client.query(
      `UPDATE users SET strategist_stage = 'new', strategist_state = '{}'::jsonb WHERE id = $1`,
      [userId],
    );
  });
  // After our own tables are wiped, best-effort erase the user's analytics person
  // too so "delete everything" also covers PostHog. No-op unless configured; can
  // never fail the wipe (own errors swallowed).
  await deletePerson(userId);
}

export async function getStage(userId: string): Promise<string> {
  const row = await queryOne<{ strategist_stage: string }>(`SELECT strategist_stage FROM users WHERE id = $1`, [userId]);
  return row?.strategist_stage ?? "new";
}

export async function setStage(userId: string, stage: string): Promise<void> {
  await query(`UPDATE users SET strategist_stage = $2 WHERE id = $1`, [userId, stage]);
}

/** True while the user is in the paced onboarding arc (not steady-state chat).
 *  Covers both the new profile-first arc and the legacy cold arc. */
export function isOnboardingPhase(state: StrategistState): boolean {
  return (
    state.phase === "profiling" ||
    state.phase === "connect_transition" ||
    state.phase === "gap_analysis" ||
    state.phase === "opening" ||
    state.phase === "diagnosis_dialogue" ||
    state.phase === "goals" ||
    state.phase === "plan_build"
  );
}

/** True only during the Stage 1-7 intake (before connect). */
export function isProfilingPhase(state: StrategistState): boolean {
  return state.phase === "profiling" || state.phase === "connect_transition";
}
