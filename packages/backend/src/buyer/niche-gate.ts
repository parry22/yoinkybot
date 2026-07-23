/**
 * Semantic niche gate — the second doctrinal gate. After deterministic intent
 * scoring, embed each candidate tweet and cosine-compare it against the ICP
 * vector. This kills domain-mismatched intent (a loud "looking for a CRM" when
 * the user sells a fitness app). Only candidates clearing BOTH the intent gate
 * and this one reach the composition agent.
 *
 * Mirrors trends/viral-scoring.ts: batch-embed, then reject when the cosine
 * distance is >= threshold (or the ICP has no vector — fail closed, since without
 * a domain vector we can't assert domain fit). The ICP vector is fetched ONCE and
 * the distance computed in-process: pgvector's `<=>` per candidate meant one DB
 * round-trip per tweet for what is arithmetic.
 */
import { config } from "../config.js";
import { queryOne } from "../db/pool.js";
import { embed } from "../llm/embeddings.js";
import type { BuyerCandidate } from "./discovery.js";

export interface GatedCandidate extends BuyerCandidate {
  /** 1 - cosine distance to the ICP vector; higher = tighter domain fit. */
  nicheSimilarity: number;
}

export interface NicheGateResult {
  passed: GatedCandidate[];
  /** False when the ICP has no embedding — the gate rejected everything by design. */
  hasVector: boolean;
}

/** Cosine distance, the same quantity pgvector's `<=>` returns (1 - cosine similarity). */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** pgvector serializes to '[0.1,0.2,...]'; node-pg hands it back as that text. */
function parseVector(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const nums = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(Number);
  return nums.length > 1 && nums.every(Number.isFinite) ? nums : null;
}

/**
 * When nothing clears the absolute threshold, rescue the top-K nearest
 * candidates inside a hard ceiling instead of returning an empty radar. A short
 * tweet and a paragraph-length ICP rarely land inside a tight fixed distance
 * (verified live 2026-07-24: every on-topic candidate sat just above the old
 * 0.55 cliff, so ZERO signals ever surfaced) — and the composition agent
 * downstream researches each candidate and declines off-fit ones anyway, so the
 * cliff was doing the agent's job badly. K stays small so the rescue can't
 * flood composition with noise.
 */
const RESCUE_TOP_K = 3;

export async function applyNicheGate(
  userId: string,
  candidates: BuyerCandidate[],
  threshold: number = config.BUYER_NICHE_THRESHOLD,
): Promise<NicheGateResult> {
  if (candidates.length === 0) return { passed: [], hasVector: true };

  const row = await queryOne<{ icp_embedding: string | null }>(
    `SELECT icp_embedding::text AS icp_embedding FROM icp_profiles WHERE user_id = $1`,
    [userId],
  );
  const icpVec = parseVector(row?.icp_embedding);
  if (!icpVec) return { passed: [], hasVector: false };

  const vecs = await embed(
    candidates.map((c) => c.tweet.text.slice(0, 500)),
    userId,
  );
  const scored: Array<{ candidate: BuyerCandidate; dist: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const vec = vecs[i];
    const candidate = candidates[i];
    if (!vec || !candidate) continue;
    scored.push({ candidate, dist: cosineDistance(vec, icpVec) });
  }
  scored.sort((a, b) => a.dist - b.dist);

  let kept = scored.filter((s) => s.dist < threshold);
  if (kept.length === 0) {
    kept = scored.filter((s) => s.dist < config.BUYER_NICHE_CEILING).slice(0, RESCUE_TOP_K);
  }
  return {
    passed: kept.map((s) => ({ ...s.candidate, nicheSimilarity: Math.round((1 - s.dist) * 1000) / 1000 })),
    hasVector: true,
  };
}
