import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { kmeans, parseVector } from "../lib/kmeans.js";
import { llmCall } from "../llm/gateway.js";
import { clusterLabel } from "../prompts/cluster-label.v1.js";

const labelSchema = z.object({
  labels: z.array(z.object({ index: z.number(), label: z.string() })),
});

/** Periodic memory-map rebuild: k-means over embeddings + cheap-LLM labels. */
export async function handleClusterRebuild(): Promise<void> {
  const users = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM memories WHERE status = 'active' AND embedding IS NOT NULL`,
  );
  for (const { user_id } of users) {
    try {
      await rebuildClustersForUser(user_id);
    } catch (err) {
      console.error(`cluster rebuild failed for ${user_id}`, err);
    }
  }
}

export async function rebuildClustersForUser(userId: string): Promise<number> {
  const rows = await query<{ id: string; content: string; embedding: string }>(
    `SELECT id, content, embedding::text AS embedding
     FROM memories WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL`,
    [userId],
  );
  if (rows.length < 5) return 0; // not enough to cluster meaningfully

  const vectors = rows.map((r) => parseVector(r.embedding));
  const k = Math.max(2, Math.min(12, Math.round(Math.sqrt(rows.length / 2))));
  const { assignments } = kmeans(vectors, k);

  const groups = new Map<number, { ids: string[]; samples: string[] }>();
  assignments.forEach((cluster, i) => {
    const g = groups.get(cluster) ?? { ids: [], samples: [] };
    g.ids.push(rows[i]!.id);
    if (g.samples.length < 6) g.samples.push(rows[i]!.content.slice(0, 200));
    groups.set(cluster, g);
  });

  const clusterInputs = [...groups.entries()].map(([index, g]) => ({ index, samples: g.samples }));
  const res = await llmCall({
    userId,
    eventType: "cluster",
    tier: clusterLabel.tier,
    system: clusterLabel.system,
    user: clusterLabel.render({ clusters: clusterInputs }),
    json: true,
    maxTokens: 512,
  });
  const labels = new Map(labelSchema.parse(res.parsed).labels.map((l) => [l.index, l.label]));

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM clusters WHERE user_id = $1`, [userId]);
    for (const [index, g] of groups) {
      await client.query(`INSERT INTO clusters (user_id, label, memory_ids) VALUES ($1, $2, $3)`, [
        userId,
        labels.get(index) ?? `Theme ${index + 1}`,
        g.ids,
      ]);
    }
  });
  return groups.size;
}
