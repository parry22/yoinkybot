import { query, queryOne, withTransaction } from "../db/pool.js";

export type SessionPhase = "opening" | "diagnosis_dialogue" | "goals" | "plan_build" | "active";

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
export interface StrategistState {
  phase?: SessionPhase;
  diagnosisId?: string; // pins the diagnosis this session is grounded in
  covered?: DiagnosisBeat[]; // beats revealed so far (the anti-dump ledger)
  goalDraft?: {
    optimizing_for?: string;
    timeframe?: string;
    success?: string;
    goal_type?: string;
  };
  planId?: string; // draft plan awaiting cadence/commit
  planCovered?: PlanBeat[]; // plan beats revealed so far (throughline → unlock → cadence)
  cadenceSet?: boolean; // draft plan has a cadence → ready to commit
  turnsInPhase?: number; // watchdog counter, reset on phase change
  lastTurnAt?: string;
  /** The bot just asked for a handle — the next bare "@handle" reply is the answer. */
  awaitingConnect?: boolean;
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
 * Full account reset (the /clear command): wipe everything derived from the
 * user's work — captures, memories, positions, the diagnosis, goals, plan,
 * chat history, connected accounts — and put them back at the 'new' stage so
 * they start the connect flow over. The user row itself (Telegram identity)
 * and their billing subscription are kept. All deletes run in one transaction
 * so a partial wipe can never strand the account half-cleared.
 *
 * Child tables are deleted before their parents; deleting `memories` cascades
 * to `memory_links`, and `surfacings` cascades to any `angles` under it.
 */
export async function resetUserData(userId: string): Promise<void> {
  const tables = [
    "unlock_items",
    "angles",
    "drafts",
    "surfacings",
    "moments",
    "brand_plans",
    "brand_diagnoses",
    "goals",
    "positions",
    "clusters",
    "voice_profiles",
    "chat_messages",
    "memories", // cascades memory_links
    "captures",
    "connected_accounts",
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
}

export async function getStage(userId: string): Promise<string> {
  const row = await queryOne<{ strategist_stage: string }>(`SELECT strategist_stage FROM users WHERE id = $1`, [userId]);
  return row?.strategist_stage ?? "new";
}

export async function setStage(userId: string, stage: string): Promise<void> {
  await query(`UPDATE users SET strategist_stage = $2 WHERE id = $1`, [userId, stage]);
}

/** True while the user is in the paced onboarding arc (not steady-state chat). */
export function isOnboardingPhase(state: StrategistState): boolean {
  return (
    state.phase === "opening" ||
    state.phase === "diagnosis_dialogue" ||
    state.phase === "goals" ||
    state.phase === "plan_build"
  );
}
