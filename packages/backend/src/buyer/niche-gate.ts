/**
 * Semantic niche gate — the second doctrinal gate. After deterministic intent
 * scoring, embed each candidate tweet and cosine-compare it against the ICP
 * vector. This kills domain-mismatched intent (a loud "looking for a CRM" when
 * the user sells a fitness app). Only candidates clearing BOTH the intent gate
 * and this one reach the composition agent.
 *
 * Mirrors trends/viral-scoring.ts: batch-embed, then per-candidate pgvector
 * distance, reject when dist >= threshold (or the ICP has no vector — fail
 * closed, since without a domain vector we can't assert domain fit).
 */
import { config } from "../config.js";
import { queryOne, toVector } from "../db/pool.js";
import { embed } from "../llm/embeddings.js";
import type { BuyerCandidate } from "./discovery.js";

export interface GatedCandidate extends BuyerCandidate {
  /** 1 - cosine distance to the ICP vector; higher = tighter domain fit. */
  nicheSimilarity: number;
}

export async function applyNicheGate(
  userId: string,
  candidates: BuyerCandidate[],
  threshold: number = config.BUYER_NICHE_THRESHOLD,
): Promise<GatedCandidate[]> {
  if (candidates.length === 0) return [];
  const vecs = await embed(
    candidates.map((c) => c.tweet.text.slice(0, 500)),
    userId,
  );
  const out: GatedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const vec = vecs[i];
    const candidate = candidates[i];
    if (!vec || !candidate) continue;
    const row = await queryOne<{ dist: number | null }>(
      `SELECT (icp_embedding <=> $2::vector) AS dist FROM icp_profiles
       WHERE user_id = $1 AND icp_embedding IS NOT NULL`,
      [userId, toVector(vec)],
    );
    const dist = row?.dist;
    if (dist === null || dist === undefined || dist >= threshold) continue;
    out.push({ ...candidate, nicheSimilarity: Math.round((1 - dist) * 1000) / 1000 });
  }
  return out;
}
