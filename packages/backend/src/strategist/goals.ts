import { query, toVector } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { setStage } from "./state.js";

export const GOAL_TYPES: Record<string, string> = {
  authority: "Build authority in a domain",
  audience: "Grow an audience to a milestone",
  company: "Support a company/product I'm building",
  opportunity: "Attract an opportunity (raise, hiring, speaking)",
  other: "Something else",
};

async function finalizeGoal(userId: string, draft: Record<string, unknown>): Promise<void> {
  const goalType = String(draft.goal_type ?? "other");
  const detail = String(draft.detail ?? draft.custom_type ?? "");
  const timeframe = draft.timeframe ? String(draft.timeframe) : null;
  const success = draft.success ? String(draft.success) : null;
  const embedding = await embedOne([detail, success].filter(Boolean).join(". "), userId);

  await query(
    `INSERT INTO goals (user_id, goal_type, detail, timeframe, definition_of_success, embedding)
     VALUES ($1,$2,$3,$4,$5,$6::vector)`,
    [userId, goalType, detail, timeframe, success, toVector(embedding)],
  );
  await setStage(userId, "goals_set");
}

export async function activeGoals(userId: string) {
  return query<{ id: string; goal_type: string; detail: string; timeframe: string | null; definition_of_success: string | null }>(
    `SELECT id, goal_type, detail, timeframe, definition_of_success FROM goals
     WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC`,
    [userId],
  );
}

/** Persist a fully drawn-out goal (the paced session's captureGoal effect lands here). */
export async function submitGoal(
  userId: string,
  input: { goalType: string; detail: string; timeframe?: string; success?: string },
): Promise<void> {
  await finalizeGoal(userId, {
    goal_type: input.goalType,
    detail: input.detail,
    timeframe: input.timeframe,
    success: input.success,
  });
}
