/**
 * Cross-domain primitive types - shapes shared by more than one subsystem that
 * don't belong to any single one of them. Keep this small and dependency-free:
 * only truly shared, low-level types live here (per-domain shared shapes go in
 * that domain's own `types.ts`, e.g. `trends/provider.ts`). No imports, no
 * runtime values - types only, so anything can depend on this without a cycle.
 */

/** The two surfaces Yoinky publishes to. Used across connect, drafting, capture. */
export type Platform = "x" | "linkedin";
