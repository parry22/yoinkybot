/** Plain k-means for memory-map clustering. Deterministic seeding so rebuilds are stable. */

export function kmeans(
  vectors: number[][],
  k: number,
  iterations = 25,
): { assignments: number[]; centroids: number[][] } {
  const n = vectors.length;
  if (n === 0 || k <= 0) return { assignments: [], centroids: [] };
  k = Math.min(k, n);
  const dims = vectors[0]!.length;

  // Deterministic k-means++-style seeding: spread initial centroids by farthest-point.
  const centroids: number[][] = [vectors[0]!.slice()];
  while (centroids.length < k) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < n; i++) {
      let d = Infinity;
      for (const c of centroids) d = Math.min(d, sqDist(vectors[i]!, c));
      if (d > bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    centroids.push(vectors[bestIdx]!.slice());
  }

  const assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(vectors[i]!, centroids[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    const sums = Array.from({ length: k }, () => new Array<number>(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const a = assignments[i]!;
      counts[a]!++;
      const v = vectors[i]!;
      const s = sums[a]!;
      for (let d = 0; d < dims; d++) s[d]! += v[d]!;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep old centroid for empty clusters
      const s = sums[c]!;
      for (let d = 0; d < dims; d++) centroids[c]![d] = s[d]! / counts[c]!;
    }
  }
  return { assignments, centroids };
}

function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s;
}

/** Parse pgvector's text representation "[0.1,0.2,...]" into number[]. */
export function parseVector(text: string): number[] {
  return text.slice(1, -1).split(",").map(Number);
}
