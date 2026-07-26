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
 * The gate is a RANKER WITH A FLOOR, not a cliff.
 *
 * A short tweet and a paragraph-length ICP rarely land inside a tight fixed
 * distance (verified live 2026-07-24: every on-topic candidate sat just above
 * the old 0.55 cutoff, so ZERO signals ever surfaced). So: everything under
 * `threshold` passes outright, and when that leaves fewer than `minKeep` the
 * nearest remaining candidates are pulled in — first under BUYER_NICHE_CEILING,
 * and if the radar is still empty, the nearest of what's left regardless.
 *
 * That last step is deliberate and is new. Domain similarity is a RANKING signal
 * here, not a truth: the fallback only ever fires when the alternative is
 * showing the user nothing, it is bounded by minKeep, and the candidate already
 * cleared the deterministic intent gate to get this far. Its distance is stored
 * on the row and shown as "% match", so a weak rescue is visibly weak rather
 * than silently presented as a strong lead.
 */
export interface NicheGateOpts {
  threshold?: number;
  /** Fill to at least this many candidates when the threshold underdelivers. */
  minKeep?: number;
}

export async function applyNicheGate(
  userId: string,
  candidates: BuyerCandidate[],
  opts: NicheGateOpts = {},
): Promise<NicheGateResult> {
  const threshold = opts.threshold ?? config.BUYER_NICHE_THRESHOLD;
  const minKeep = Math.max(0, opts.minKeep ?? 0);
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

  const kept = scored.filter((s) => s.dist < threshold);
  if (kept.length < minKeep) {
    const already = new Set(kept.map((s) => s.candidate.tweet.id));
    const fill = (pool: typeof scored) => {
      for (const s of pool) {
        if (kept.length >= minKeep) break;
        if (already.has(s.candidate.tweet.id)) continue;
        already.add(s.candidate.tweet.id);
        kept.push(s);
      }
    };
    fill(scored.filter((s) => s.dist < config.BUYER_NICHE_CEILING));
    fill(scored);
  }
  return {
    passed: kept.map((s) => ({ ...s.candidate, nicheSimilarity: Math.round((1 - s.dist) * 1000) / 1000 })),
    hasVector: true,
  };
}
