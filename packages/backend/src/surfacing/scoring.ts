/**
 * Deterministic resurfacing scorer - PRD 4.3: novelty × link-density × recency
 * ÷ prior surface count. No LLM anywhere in selection; the LLM only composes
 * the delivery after the choice is made. Pure functions, unit-tested.
 */

export interface ScorableMemory {
  id: string;
  createdAt: number; // epoch ms
  lastSurfacedAt: number | null;
  surfaceCount: number;
  linkCount: number;
  /** net reaction signal from past surfacings: 🔥 = +1 each, 💤 = -1 each */
  reactionNet: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** 0..1 - how "fresh to the user" this memory is. Never surfaced = fully novel. */
export function novelty(m: ScorableMemory, now: number): number {
  if (m.lastSurfacedAt === null) return 1;
  const days = (now - m.lastSurfacedAt) / DAY;
  return 1 - Math.exp(-days / 30);
}

/** ≥1 - well-connected ideas are worth more; growth is logarithmic. */
export function linkDensity(m: ScorableMemory): number {
  return 1 + Math.log1p(m.linkCount);
}

/**
 * Recency of capture with a floor: fresh ideas score higher, but an old idea
 * never decays to zero - link density can still carry it back up.
 */
export function recency(m: ScorableMemory, now: number): number {
  const ageDays = Math.max(0, now - m.createdAt) / DAY;
  return 0.35 + 0.65 * Math.exp(-ageDays / 45);
}

/** Reaction feedback: 🔥 boosts, 💤 suppresses; clamped so it tunes, not dominates. */
export function reactionBoost(m: ScorableMemory): number {
  return Math.min(1.5, Math.max(0.4, 1 + 0.25 * m.reactionNet));
}

export function score(m: ScorableMemory, now: number): number {
  return (
    (novelty(m, now) * linkDensity(m) * recency(m, now) * reactionBoost(m)) /
    (1 + m.surfaceCount)
  );
}

export function pickBest(memories: ScorableMemory[], now: number): ScorableMemory | undefined {
  let best: ScorableMemory | undefined;
  let bestScore = -Infinity;
  for (const m of memories) {
    const s = score(m, now);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}

/** Human-readable scoring reason, passed to the composer for "why this, now". */
export function explainScore(m: ScorableMemory, now: number): string {
  const parts: string[] = [];
  if (m.lastSurfacedAt === null) parts.push("never resurfaced before");
  else parts.push(`last resurfaced ${Math.round((now - m.lastSurfacedAt) / DAY)} days ago`);
  if (m.linkCount > 0) parts.push(`connected to ${m.linkCount} other thought${m.linkCount === 1 ? "" : "s"}`);
  const ageDays = Math.round((now - m.createdAt) / DAY);
  parts.push(ageDays === 0 ? "captured today" : `captured ${ageDays} days ago`);
  if (m.reactionNet > 0) parts.push("similar resurfacings were marked useful");
  return parts.join("; ");
}
