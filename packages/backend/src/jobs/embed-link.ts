import { z } from "zod";
import { query, queryOne, toVector } from "../db/pool.js";
import type { EmbedLinkJob } from "./boss.js";
import { embedOne } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { classifyLink } from "../prompts/classify-link.v1.js";

/** Only neighbors closer than this cosine distance are candidates for linking. */
const NEIGHBOR_DISTANCE = 0.55;
const NEIGHBOR_K = 8;

const linkSchema = z.object({
  links: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["extends", "contradicts", "echoes", "answers", "none"]),
      strength: z.number().min(0).max(1),
    }),
  ),
});

/**
 * Embed a new memory, then auto-link: pgvector finds candidate neighbors,
 * the cheap LLM decides which relations are real and how they connect.
 */
export async function handleEmbedLink(job: EmbedLinkJob): Promise<void> {
  const memory = await queryOne<{ id: string; content: string }>(
    `SELECT id, content FROM memories WHERE id = $1 AND status = 'active'`,
    [job.memoryId],
  );
  if (!memory) return; // forgotten before processing - nothing to do

  const embedding = await embedOne(memory.content, job.userId);
  await query(`UPDATE memories SET embedding = $2::vector WHERE id = $1`, [memory.id, toVector(embedding)]);

  const neighbors = await query<{ id: string; content: string; distance: number }>(
    `SELECT id, content, (embedding <=> $2::vector) AS distance
     FROM memories
     WHERE user_id = $1 AND id <> $3 AND status = 'active' AND embedding IS NOT NULL
       AND (embedding <=> $2::vector) < $4
     ORDER BY embedding <=> $2::vector
     LIMIT $5`,
    [job.userId, toVector(embedding), memory.id, NEIGHBOR_DISTANCE, NEIGHBOR_K],
  );
  if (neighbors.length === 0) return;

  const res = await llmCall({
    userId: job.userId,
    eventType: "link",
    tier: classifyLink.tier,
    system: classifyLink.system,
    user: classifyLink.render({
      newMemory: memory.content,
      neighbors: neighbors.map((n) => ({ id: n.id, content: n.content })),
    }),
    json: true,
    maxTokens: 1024,
  });
  const parsed = linkSchema.parse(res.parsed);
  const validIds = new Set(neighbors.map((n) => n.id));

  for (const link of parsed.links) {
    if (link.type === "none" || !validIds.has(link.id)) continue;
    await query(
      `INSERT INTO memory_links (memory_a, memory_b, link_type, strength, created_by)
       VALUES ($1, $2, $3, $4, 'auto')
       ON CONFLICT (memory_a, memory_b, link_type) DO UPDATE SET strength = EXCLUDED.strength`,
      [memory.id, link.id, link.type, link.strength],
    );
  }
}
