import { z } from "zod";
import { config } from "../config.js";
import { query, queryOne, toVector } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { runAgentLoop } from "../agent-runtime/run-agent-loop.js";
import { hybridSearch } from "../memory/search.js";
import { consistencyCheck } from "../prompts/consistency-check.v1.js";
import { consistencyAgent } from "../prompts/consistency-check.v2.js";
import { consistencyToolSchema } from "./tools.js";

const resultSchema = z.object({
  contradictions: z
    .array(z.object({ position_id: z.string(), explanation: z.string() }))
    .default([]),
  reinforcements: z.array(z.object({ position_id: z.string() })).default([]),
  // How sure the single-shot pass is of its own verdict. Low → escalate to the
  // bounded agent rather than acting on a snap call. Missing/garbled → treat as
  // confident (1) so a model that ignores the field keeps the old behaviour.
  confidence: z.number().min(0).max(1).catch(1),
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
  /** Informational reads that aren't warnings (e.g. an intentional evolution). */
  notes?: string[];
}

/**
 * Pre-publish check: embed the draft, retrieve nearby positions, let the
 * frontier model compare meaning. Flags show the exact prior statement,
 * its dates, and its source memories — never a vague warning.
 *
 * Two paths, chosen by a deterministic ambiguity signal (never by the model):
 * the common case — one clean top match with a clear similarity margin — stays
 * a single-shot compare (v1). The bounded agent (v2) runs on either of two
 * signals: (a) the top-2 matches sit within CONSISTENCY_AMBIGUITY_DELTA of each
 * other ("which position is this even about" is genuinely uncertain), decided
 * from embeddings before any model call; or (b) the single-shot pass itself
 * comes back below CONSISTENCY_CONFIDENCE_THRESHOLD — a shaky first read is
 * escalated to the deeper pass instead of being acted on. Either way the code
 * decides when to spend the loop; the model never chooses to wander.
 */
export async function checkConsistency(userId: string, draft: string): Promise<ConsistencyResult> {
  const embedding = await embedOne(draft, userId);
  const nearby = await query<{
    id: string;
    statement: string;
    first_stated_at: string;
    last_affirmed_at: string;
    source_memory_ids: string[];
    distance: number;
  }>(
    `SELECT id, statement, first_stated_at::text, last_affirmed_at::text, source_memory_ids,
            (embedding <=> $2::vector) AS distance
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

  const ambiguous =
    nearby.length >= 2 && nearby[1]!.distance - nearby[0]!.distance < config.CONSISTENCY_AMBIGUITY_DELTA;
  if (ambiguous) {
    try {
      return await checkWithAgent(userId, draft, nearby, throughline);
    } catch (err) {
      // The agent path is an upgrade, not a dependency — fall through to the
      // single-shot compare rather than failing the check.
      console.error("consistency agent failed; falling back to single-shot compare", err);
    }
  }

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

  // Second escalation signal: the single-shot pass isn't sure of its own
  // verdict. Rather than act on a snap call (and risk a trust-eroding false
  // flag), hand it to the bounded agent to pin down the real conflict. Only
  // from this non-ambiguous path — the ambiguous branch already ran the agent.
  if (parsed.confidence < config.CONSISTENCY_CONFIDENCE_THRESHOLD) {
    try {
      return await checkWithAgent(userId, draft, nearby, throughline);
    } catch (err) {
      // Same upgrade-not-dependency stance as the ambiguous branch: fall
      // through and report the single-shot result rather than fail the check.
      console.error("consistency agent (low-confidence escalation) failed; using single-shot result", err);
    }
  }

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

  const surfacingId = await persistFlags(userId, draft, flags);
  return { clear: flags.length === 0, flags, checkedPositions: nearby.length, surfacingId };
}

async function persistFlags(
  userId: string,
  draft: string,
  flags: ConsistencyFlag[],
  extraPayload: Record<string, unknown> = {},
): Promise<string | undefined> {
  if (flags.length === 0) return undefined;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, $2, 'consistency_flag', $3, 'web') RETURNING id`,
    [
      userId,
      flags.flatMap((f) => f.sources.map((s) => s.id)),
      JSON.stringify({ draft: draft.slice(0, 2000), flags: flags.map(({ sources: _s, ...f }) => f), ...extraPayload }),
    ],
  );
  return row?.id;
}

const agentResultSchema = z.object({
  resolution: z.enum(["intentional_evolution", "catch_it", "no_conflict"]).catch("no_conflict"),
  position_id: z.string().nullish(),
  prior_statement: z.string().catch(""),
  date: z.string().catch(""),
  source: z.string().catch(""),
  explanation: z.string().catch(""),
  confidence: z.number().min(0).max(1).catch(0),
});

interface NearbyPosition {
  id: string;
  statement: string;
  first_stated_at: string;
  last_affirmed_at: string;
  source_memory_ids: string[];
  distance: number;
}

/**
 * The bounded agent path for a genuinely ambiguous match. The tools let the
 * model pin down WHICH prior statement (if any) the draft conflicts with;
 * verdicts under CONSISTENCY_CONFIDENCE_THRESHOLD are reported as clear —
 * a shaky catch costs more trust than a missed one.
 */
async function checkWithAgent(
  userId: string,
  draft: string,
  nearby: NearbyPosition[],
  throughline: string | undefined,
): Promise<ConsistencyResult> {
  const shownIds = nearby.map((p) => p.id);

  const executors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    search_more_positions: async (args) => {
      const q = String(args.query ?? "");
      const emb = await embedOne(q, userId);
      const rows = await query<{ id: string; statement: string; first_stated_at: string; last_affirmed_at: string }>(
        `SELECT id, statement, first_stated_at::text, last_affirmed_at::text
         FROM positions
         WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
           AND NOT (id = ANY($3::uuid[]))
         ORDER BY embedding <=> $2::vector
         LIMIT 8`,
        [userId, toVector(emb), shownIds],
      );
      if (rows.length === 0) return "no further positions found";
      return rows
        .map((p) => `[${p.id}] (first: ${p.first_stated_at.slice(0, 10)}, last: ${p.last_affirmed_at.slice(0, 10)}) ${p.statement}`)
        .join("\n");
    },
    get_position_context: async (args) => {
      const id = String(args.position_id ?? "");
      const pos = await queryOne<NearbyPosition & { status: string }>(
        `SELECT id, statement, first_stated_at::text, last_affirmed_at::text, source_memory_ids, status, 0 AS distance
         FROM positions WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!pos) return "no such position";
      const sources = pos.source_memory_ids.length
        ? await query<{ content: string; created_at: string }>(
            `SELECT content, created_at::text FROM memories WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC LIMIT 4`,
            [pos.source_memory_ids],
          )
        : [];
      return (
        `"${pos.statement}" (status: ${pos.status}, first: ${pos.first_stated_at.slice(0, 10)}, last affirmed: ${pos.last_affirmed_at.slice(0, 10)})\n` +
        (sources.length
          ? `source statements:\n${sources.map((s) => `- (${s.created_at.slice(0, 10)}) ${s.content.slice(0, 280)}`).join("\n")}`
          : "no source memories recorded")
      );
    },
    search_memory: async (args) => {
      const q = String(args.query ?? "");
      const rows = await hybridSearch(userId, q, 5);
      if (rows.length === 0) return "nothing in memory matches";
      return rows.map((m) => `- (${m.kind}, ${m.created_at.slice(0, 10)}) ${m.content.slice(0, 280)}`).join("\n");
    },
  };

  const { output, steps } = await runAgentLoop("consistency", {
    userId,
    eventType: "consistency",
    tier: consistencyAgent.tier,
    system: consistencyAgent.system,
    renderUser: (notes) =>
      consistencyAgent.render({
        draft,
        positions: nearby,
        throughline,
        toolNotes: notes,
        toolCallsRemaining: Math.max(0, config.CONSISTENCY_MAX_TOOL_CALLS - notes.length),
      }),
    toolSchema: consistencyToolSchema,
    executors,
    outputSchema: agentResultSchema,
    maxToolCalls: config.CONSISTENCY_MAX_TOOL_CALLS,
    maxTokens: 700,
  });

  const confident = output.confidence >= config.CONSISTENCY_CONFIDENCE_THRESHOLD;
  const trail = { agent: true, steps: steps.map((s) => ({ tool: s.tool, args: s.args })), confidence: output.confidence };

  if (output.resolution === "catch_it" && confident) {
    const pos = output.position_id ? nearby.find((p) => p.id === output.position_id) : undefined;
    const sources = pos?.source_memory_ids.length
      ? await query<{ id: string; content: string; created_at: string }>(
          `SELECT id, content, created_at::text FROM memories WHERE id = ANY($1::uuid[]) LIMIT 3`,
          [pos.source_memory_ids],
        )
      : [];
    const flag: ConsistencyFlag = {
      positionId: pos?.id ?? output.position_id ?? "unknown",
      statement: output.prior_statement || pos?.statement || "",
      firstStatedAt: pos?.first_stated_at ?? output.date,
      lastAffirmedAt: pos?.last_affirmed_at ?? "",
      explanation: output.explanation,
      sources,
    };
    const surfacingId = await persistFlags(userId, draft, [flag], trail);
    return { clear: false, flags: [flag], checkedPositions: nearby.length, surfacingId };
  }

  const notes: string[] = [];
  if (output.resolution === "intentional_evolution" && confident) {
    notes.push(
      `reads as intentional evolution, not a slip: you said "${output.prior_statement}"${
        output.date ? ` (${output.date.slice(0, 10)})` : ""
      } — ${output.explanation}`,
    );
  }
  return { clear: true, flags: [], checkedPositions: nearby.length, notes: notes.length ? notes : undefined };
}
