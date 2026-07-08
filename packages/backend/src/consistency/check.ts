import { z } from "zod";
import { query, queryOne, toVector } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { consistencyCheck } from "../prompts/consistency-check.v1.js";

const resultSchema = z.object({
  contradictions: z
    .array(z.object({ position_id: z.string(), explanation: z.string() }))
    .default([]),
  reinforcements: z.array(z.object({ position_id: z.string() })).default([]),
});

export interface ConsistencyFlag {
  positionId: string;
  statement: string;
  firstStatedAt: string;
  lastAffirmedAt: string;
  explanation: string;
  /** Source memories behind the position, so the user sees exactly where it came from. */
  sources: Array<{ id: string; content: string; created_at: string }>;
}

export interface ConsistencyResult {
  clear: boolean;
  flags: ConsistencyFlag[];
  checkedPositions: number;
  surfacingId?: string;
}

/**
 * Pre-publish check: embed the draft, retrieve nearby positions, let the
 * frontier model compare meaning. Flags show the exact prior statement,
 * its dates, and its source memories — never a vague warning.
 */
export async function checkConsistency(userId: string, draft: string): Promise<ConsistencyResult> {
  const embedding = await embedOne(draft, userId);
  const nearby = await query<{
    id: string;
    statement: string;
    first_stated_at: string;
    last_affirmed_at: string;
    source_memory_ids: string[];
  }>(
    `SELECT id, statement, first_stated_at::text, last_affirmed_at::text, source_memory_ids
     FROM positions
     WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
       AND (embedding <=> $2::vector) < 0.6
     ORDER BY embedding <=> $2::vector
     LIMIT 12`,
    [userId, toVector(embedding)],
  );
  // The active plan throughline, if any — lets the check flag off-brand drift.
  const planRow = await queryOne<{ throughline: string }>(
    `SELECT throughline FROM brand_plans WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const throughline = planRow?.throughline;

  if (nearby.length === 0 && !throughline) return { clear: true, flags: [], checkedPositions: 0 };

  const res = await llmCall({
    userId,
    eventType: "consistency",
    tier: consistencyCheck.tier,
    system: consistencyCheck.system,
    user: consistencyCheck.render({ draft, positions: nearby, throughline }),
    json: true,
    maxTokens: 1024,
  });
  const parsed = resultSchema.parse(res.parsed);

  // Reinforcements re-affirm the position's recency.
  for (const r of parsed.reinforcements) {
    await query(`UPDATE positions SET last_affirmed_at = now() WHERE id = $1 AND user_id = $2`, [
      r.position_id,
      userId,
    ]);
  }

  const flags: ConsistencyFlag[] = [];
  for (const c of parsed.contradictions) {
    // Off-brand drift from the throughline is reported under a synthetic id.
    if (c.position_id === "throughline" && throughline) {
      flags.push({
        positionId: "throughline",
        statement: throughline,
        firstStatedAt: "",
        lastAffirmedAt: "",
        explanation: c.explanation,
        sources: [],
      });
      continue;
    }
    const pos = nearby.find((p) => p.id === c.position_id);
    if (!pos) continue;
    const sources = pos.source_memory_ids.length
      ? await query<{ id: string; content: string; created_at: string }>(
          `SELECT id, content, created_at::text FROM memories WHERE id = ANY($1::uuid[]) LIMIT 3`,
          [pos.source_memory_ids],
        )
      : [];
    flags.push({
      positionId: pos.id,
      statement: pos.statement,
      firstStatedAt: pos.first_stated_at,
      lastAffirmedAt: pos.last_affirmed_at,
      explanation: c.explanation,
      sources,
    });
  }

  let surfacingId: string | undefined;
  if (flags.length > 0) {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
       VALUES ($1, $2, 'consistency_flag', $3, 'web') RETURNING id`,
      [
        userId,
        flags.flatMap((f) => f.sources.map((s) => s.id)),
        JSON.stringify({ draft: draft.slice(0, 2000), flags: flags.map(({ sources: _s, ...f }) => f) }),
      ],
    );
    surfacingId = row?.id;
  }

  return { clear: flags.length === 0, flags, checkedPositions: nearby.length, surfacingId };
}
