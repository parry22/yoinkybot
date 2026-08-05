/**
 * Belief confidence + reconciliation decisions - pure functions, no I/O.
 * Confidence is computed lazily at read time (no sweep job): it rises with
 * reinforcement and decays with time since the belief was last affirmed, so a
 * position stated once eight months ago stops outranking last week's thinking.
 */

const DAY = 24 * 60 * 60 * 1000;
export const CONFIDENCE_HALF_LIFE_DAYS = 90;

/** Floor below which a decayed position is treated as stale and dropped from prompts. */
export const STALE_CONFIDENCE = 0.15;

/**
 * 0.05..0.95 - base from reinforcement count (how many times they've said it),
 * halved every 90 days since it was last affirmed.
 */
export function effectiveConfidence(reinforcement: number, lastAffirmedAt: number, now: number): number {
  const base = Math.min(0.95, 0.6 + 0.07 * Math.min(Math.max(reinforcement, 1), 5));
  const days = Math.max(0, now - lastAffirmedAt) / DAY;
  return Math.max(0.05, base * Math.pow(0.5, days / CONFIDENCE_HALF_LIFE_DAYS));
}

export type Relation = "same" | "contradicts" | "unrelated";

export interface ReconcileDecision {
  /** Existing position the new statement re-affirms, if any. */
  reinforceId?: string;
  /** Existing positions the new statement replaces (kept as history). */
  supersedeIds: string[];
  /** Whether a new position row is inserted. */
  insert: boolean;
}

/**
 * Turn per-candidate judgments into one deterministic decision:
 * - a "same" match wins → reinforce it (never insert a duplicate belief);
 * - every "contradicts" match is superseded - by the reinforced position if
 *   there is one, otherwise by the newly inserted statement;
 * - nothing matches → plain insert.
 */
export function decideReconciliation(judgments: Array<{ id: string; relation: Relation }>): ReconcileDecision {
  const reinforceId = judgments.find((j) => j.relation === "same")?.id;
  const supersedeIds = judgments.filter((j) => j.relation === "contradicts" && j.id !== reinforceId).map((j) => j.id);
  return { reinforceId, supersedeIds, insert: !reinforceId };
}
