import { z } from "zod";
import { query } from "../db/pool.js";
import { toVector } from "../db/pool.js";
import { embedOne } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { synthesizeAnswer } from "../prompts/synthesize-answer.v1.js";

export interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  created_at: string;
  capture_id: string | null;
}

const answerSchema = z.object({
  answer: z.string(),
  cited_memory_ids: z.array(z.string()).default([]),
});

/**
 * Hybrid retrieval: vector similarity + full-text, fused with reciprocal rank
 * fusion. Returns the ranked memories; `searchAndSynthesize` adds the LLM answer.
 */
export async function hybridSearch(userId: string, queryText: string, limit = 10): Promise<MemoryRow[]> {
  const embedding = await embedOne(queryText, userId);

  const [vecRows, ftsRows] = await Promise.all([
    query<MemoryRow>(
      `SELECT id, content, kind, created_at::text, capture_id
       FROM memories
       WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT 20`,
      [userId, toVector(embedding)],
    ),
    query<MemoryRow>(
      `SELECT id, content, kind, created_at::text, capture_id
       FROM memories
       WHERE user_id = $1 AND status = 'active'
         AND tsv @@ websearch_to_tsquery('english', $2)
       ORDER BY ts_rank(tsv, websearch_to_tsquery('english', $2)) DESC
       LIMIT 20`,
      [userId, queryText],
    ),
  ]);

  return fuseRrf([vecRows, ftsRows]).slice(0, limit);
}

/** Reciprocal rank fusion across result lists. Exported for unit tests. */
export function fuseRrf<T extends { id: string }>(lists: T[][], k = 60): T[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const cur = scores.get(item.id) ?? { item, score: 0 };
      cur.score += 1 / (k + rank + 1);
      scores.set(item.id, cur);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((s) => s.item);
}

export async function searchAndSynthesize(
  userId: string,
  question: string,
): Promise<{ answer: string; memories: MemoryRow[]; cited: string[] }> {
  const memories = await hybridSearch(userId, question);
  if (memories.length === 0) {
    return { answer: "Nothing in your memory matches that yet.", memories: [], cited: [] };
  }
  const res = await llmCall({
    userId,
    eventType: "search",
    tier: synthesizeAnswer.tier,
    system: synthesizeAnswer.system,
    user: synthesizeAnswer.render({ question, memories }),
    json: true,
    maxTokens: 1024,
  });
  const parsed = answerSchema.parse(res.parsed);
  return { answer: parsed.answer, memories, cited: parsed.cited_memory_ids };
}
