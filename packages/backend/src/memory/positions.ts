import { query, queryOne, toVector } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { z } from "zod";
import { reconcilePosition } from "../prompts/reconcile-position.v1.js";
import { effectiveConfidence, decideReconciliation, STALE_CONFIDENCE, type Relation } from "./confidence.js";

/** Cosine distance below which two statements are "the same position" without asking a model. */
const SAME_POSITION_DISTANCE = 0.15;
/** Cosine distance under which an existing position is close enough to need a semantic judgment. */
const RELATED_DISTANCE = 0.45;
const MAX_CANDIDATES = 4;

export interface Position {
  id: string;
  user_id: string;
  statement: string;
  first_stated_at: string;
  last_affirmed_at: string;
  source_memory_ids: string[];
  version: number;
  status: string;
}

export interface PositionChange {
  position: Position;
  action: "new" | "reinforced" | "superseded";
  /** Statements this one replaced (only for action = superseded). */
  replaced: string[];
}

/** pg returns timestamptz as Date; the Position contract is ISO strings. Normalize at the boundary. */
function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
function normalize<T extends { first_stated_at: unknown; last_affirmed_at: unknown }>(row: T): T {
  return { ...row, first_stated_at: iso(row.first_stated_at), last_affirmed_at: iso(row.last_affirmed_at) };
}

const judgmentSchema = z.object({
  judgments: z
    .array(
      z.object({
        id: z.string(),
        relation: z.enum(["same", "contradicts", "unrelated"]).catch("unrelated"),
      }),
    )
    .default([]),
});

/**
 * The self-correcting write path for beliefs. A newly stated position is
 * reconciled against nearby active positions instead of piling up next to them:
 *
 * - clearly identical (tight embedding match) → reinforce, no model call;
 * - semantically nearby → a cheap LLM judges same / contradicts / unrelated;
 *   "same" reinforces, every "contradicts" is superseded (kept as history with
 *   superseded_by), anything else coexists;
 * - judge unavailable → fall back to plain insert (the old accretive behavior),
 *   never block the capture pipeline on reconciliation.
 */
export async function upsertPosition(
  userId: string,
  statement: string,
  sourceMemoryId: string,
): Promise<PositionChange> {
  const embedding = await embedOne(statement, userId);
  const nearby = (
    await query<Position & { distance: number }>(
      `SELECT *, (embedding <=> $2::vector) AS distance
       FROM positions
       WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
         AND (embedding <=> $2::vector) < $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [userId, toVector(embedding), RELATED_DISTANCE, MAX_CANDIDATES],
    )
  ).map(normalize);

  // Fast path: near-duplicate wording is a re-affirmation, no judgment needed.
  if (nearby[0] && nearby[0].distance < SAME_POSITION_DISTANCE) {
    return { position: await reinforce(nearby[0].id, sourceMemoryId), action: "reinforced", replaced: [] };
  }

  let judgments: Array<{ id: string; relation: Relation }> = [];
  if (nearby.length > 0) {
    try {
      const res = await llmCall({
        userId,
        eventType: "reconcile",
        tier: reconcilePosition.tier,
        system: reconcilePosition.system,
        user: reconcilePosition.render({
          statement,
          candidates: nearby.map((p) => ({ id: p.id, statement: p.statement, lastAffirmedAt: p.last_affirmed_at })),
        }),
        json: true,
        maxTokens: 512,
      });
      const valid = new Set(nearby.map((p) => p.id));
      judgments = judgmentSchema.parse(res.parsed).judgments.filter((j) => valid.has(j.id));
    } catch (err) {
      console.error("position reconciliation judge failed; inserting without reconciling", err);
    }
  }

  const decision = decideReconciliation(judgments);

  if (decision.reinforceId) {
    const position = await reinforce(decision.reinforceId, sourceMemoryId);
    if (decision.supersedeIds.length) {
      // The re-affirmed belief also displaces old ones that contradict it.
      await supersede(userId, decision.supersedeIds, position.id);
    }
    return { position, action: "reinforced", replaced: [] };
  }

  const inserted = normalize(
    (await queryOne(
      `INSERT INTO positions (user_id, profile_id, statement, source_memory_ids, embedding)
       VALUES ($1, $1, $2, ARRAY[$3]::uuid[], $4::vector) RETURNING *`,
      [userId, statement, sourceMemoryId, toVector(embedding)],
    )) as unknown as Position,
  );

  if (decision.supersedeIds.length === 0) return { position: inserted, action: "new", replaced: [] };

  const replaced = await supersede(userId, decision.supersedeIds, inserted.id);
  return { position: inserted, action: "superseded", replaced };
}

async function reinforce(positionId: string, sourceMemoryId: string): Promise<Position> {
  return normalize(
    (await queryOne(
      `UPDATE positions
       SET last_affirmed_at = now(),
           source_memory_ids = array_append(source_memory_ids, $2)
       WHERE id = $1 RETURNING *`,
      [positionId, sourceMemoryId],
    )) as unknown as Position,
  );
}

/** Retire contradicted positions, keeping them as history pointing at their successor. */
async function supersede(userId: string, ids: string[], byId: string): Promise<string[]> {
  const rows = await query<{ statement: string }>(
    `UPDATE positions SET status = 'evolved', superseded_by = $3
     WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status = 'active'
     RETURNING statement`,
    [ids, userId, byId],
  );
  return rows.map((r) => r.statement);
}

/**
 * "Intentional evolution" (user-driven): the old position is kept as history
 * and the new statement becomes the active version, inheriting the evidence.
 */
export async function evolvePosition(userId: string, positionId: string, newStatement: string): Promise<Position> {
  const old = await queryOne<Position>(`SELECT * FROM positions WHERE id = $1 AND user_id = $2`, [
    positionId,
    userId,
  ]);
  if (!old) throw new Error("position not found");
  const embedding = await embedOne(newStatement, userId);
  const next = normalize(
    (await queryOne(
      `INSERT INTO positions (user_id, profile_id, statement, source_memory_ids, embedding, version)
       VALUES ($1, $1, $2, $3, $4::vector, $5) RETURNING *`,
      [userId, newStatement, old.source_memory_ids, toVector(embedding), old.version + 1],
    )) as unknown as Position,
  );
  await supersede(userId, [old.id], next.id);
  return next;
}

export interface WeightedPosition extends Position {
  /** 0.05..0.95 — reinforcement-boosted, decayed by time since last affirmation. */
  confidence: number;
}

/**
 * Active positions with effective confidence, strongest first. Positions that
 * have decayed below the stale floor are excluded by default so old one-off
 * statements stop steering prompts; pass includeStale for display surfaces.
 */
export async function activePositions(
  userId: string,
  opts: { includeStale?: boolean } = {},
): Promise<WeightedPosition[]> {
  const rows = await query<Position & { reinforcement: number }>(
    `SELECT id, user_id, statement, first_stated_at, last_affirmed_at, source_memory_ids, version, status,
            COALESCE(array_length(source_memory_ids, 1), 1) AS reinforcement
     FROM positions WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  const now = Date.now();
  const weighted = rows.map(normalize).map((r) => ({
    ...r,
    confidence: effectiveConfidence(r.reinforcement, new Date(r.last_affirmed_at).getTime(), now),
  }));
  const filtered = opts.includeStale ? weighted : weighted.filter((p) => p.confidence >= STALE_CONFIDENCE);
  return filtered.sort((a, b) => b.confidence - a.confidence);
}

/** Full belief history for a user: active + evolved, oldest first (the timeline). */
export async function positionHistory(userId: string): Promise<Array<Position & { superseded_by: string | null }>> {
  return query(
    `SELECT id, user_id, statement, first_stated_at::text, last_affirmed_at::text,
            source_memory_ids, version, status, superseded_by
     FROM positions WHERE user_id = $1 ORDER BY first_stated_at ASC`,
    [userId],
  ) as unknown as Promise<Array<Position & { superseded_by: string | null }>>;
}
