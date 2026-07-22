/**
 * Source-selector contract (§3). A selector is DETERMINISTIC: it returns the
 * single best eligible item for a user right now, applying the same gates the
 * item's proactive path already applies, and NEVER calls an LLM. Types only, no
 * runtime imports beyond types (the chat-tools.ts rule) so it can't cycle.
 */
import type { Automation } from "../types.js";

export interface SourceItem {
  /** The seed/topic handed to the draft path (generateDraft's `request`). */
  seed: string;
  /** Short human label for the framing DM (e.g. the trend topic). */
  label: string;
  /** Persisted to automation_runs.source_ref for dedup + inspection. */
  sourceRef: Record<string, unknown>;
}

export type SourceSelector = (userId: string, automation: Automation) => Promise<SourceItem | null>;
export type CostProfile = "shared_pool" | "per_user_paid" | "free_local";
