import { ALL_TONE_KEYS, TONE_LABEL } from "../strategist/profile.js";

/**
 * Shared taxonomy + pure helpers for post classification (rhetorical mode,
 * sincerity register, motive, campaign detection). Classified at CAPTURE
 * granularity - see jobs/extract.ts. No I/O in this file; every downstream
 * consumer (evidence.ts, voice/profile.ts, performance.ts, corrections) calls
 * into the same predicates here so "how conservative are we about ambiguity"
 * lives in exactly one place.
 */

export { ALL_TONE_KEYS, TONE_LABEL };

export const SINCERITY_VALUES = ["sincere", "ironic", "self_deprecating", "absurdist", "ambiguous"] as const;
export type SincerityRegister = (typeof SINCERITY_VALUES)[number];

export const SINCERITY_LABEL: Record<SincerityRegister, string> = {
  sincere: "Sincere",
  ironic: "Ironic",
  self_deprecating: "Self-deprecating",
  absurdist: "Absurdist",
  ambiguous: "Ambiguous",
};

export const MOTIVE_VALUES = [
  "authority_building",
  "relationship_building",
  "audience_growth",
  "lead_generation",
  "personal_processing",
  "community_participation",
  "campaign_installment",
] as const;
export type Motive = (typeof MOTIVE_VALUES)[number];

/** Below this, a "sincere" call isn't trusted enough to gate on either. */
export const SINCERITY_CONFIDENCE_THRESHOLD = 0.5;

/**
 * The single predicate every downstream filter calls. Conservative by design:
 * anything other than a confident "sincere" is treated as NOT sincere -
 * ironic/self_deprecating/absurdist/ambiguous, or a low-confidence "sincere",
 * all fail closed. NULL (classified before this feature existed, or a parse
 * failure) is treated as sincere for backward compatibility, matching the
 * `orientation IS NULL` tolerance precedent elsewhere in this codebase - this
 * predicate is for NEW gating decisions, not for retroactively distrusting
 * data that predates the feature.
 */
export function isSincereEnough(
  register: string | null | undefined,
  confidence: number | null | undefined,
): boolean {
  if (register == null) return true;
  if (register !== "sincere") return false;
  return (confidence ?? 0) >= SINCERITY_CONFIDENCE_THRESHOLD;
}

/**
 * Deterministic, pre-LLM detection of a structural series marker: numbered
 * updates ("day 14", "part 3 of X", "update #7"), or a repeated bracketed/
 * hashtag tag ("[buildinpublic]", "#100DaysOfCode"). Pure text, computed
 * before the classification call so the model is told the marker as fact
 * rather than asked to notice it - matches the deterministic-then-interpret
 * doctrine used throughout this codebase (evidence.ts, performance.ts,
 * gap.ts). Returns a normalized marker "family" string usable to match this
 * post against an existing campaign, or null when nothing matches.
 */
export function detectStructuralMarker(text: string): string | null {
  if (/\bday\s+#?\d+\b/i.test(text)) return "day-series";
  if (/\bweek\s+#?\d+\b/i.test(text)) return "week-series";
  if (/\b(?:part|update|episode|chapter)\s*#?\d+\b/i.test(text)) return "numbered-series";

  // A bracketed tag used as a running label, e.g. "[buildinpublic]", "[bip]".
  const bracket = text.match(/\[([a-z0-9_ -]{2,30})\]/i);
  if (bracket) return `tag:${bracket[1]!.trim().toLowerCase()}`;

  // A hashtag that itself encodes a day/series count, e.g. "#100DaysOfCode",
  // "#Day14", "#buildinpublic" (common enough to treat as its own family even
  // without a number).
  const hashtag = text.match(/#(\w*(?:day|days|week|part)\w*\d*|\w*buildinpublic\w*)/i);
  if (hashtag) return `tag:${hashtag[1]!.toLowerCase()}`;

  return null;
}
