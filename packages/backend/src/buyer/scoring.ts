/**
 * Deterministic intent scoring — the doctrinal spine of Buyer Radar. Pure, no
 * I/O, no LLM (sibling of trends/scoring.ts#buzzScore and engagement/heuristics.ts).
 * Code decides who is a buyer; the composition model only researches, drafts, and
 * may DECLINE. It never widens the candidate set.
 *
 * A deliberate inversion lives here: unlike buzzScore, where a high reply count is
 * signal, for a prospect tweet a high reply count is a PENALTY — the user is late
 * to a crowded thread and will be buried. We prefer fresh + low-reply. See the
 * `crowding` component.
 */

export type IntentType = "explicit_ask" | "competitor_dissatisfaction" | "pain" | "trigger_event";

/** The bucket weight: an explicit ask beats a vague pain by construction. */
const PROVENANCE_WEIGHT: Record<IntentType, number> = {
  explicit_ask: 1.0,
  competitor_dissatisfaction: 0.8,
  pain: 0.55,
  trigger_event: 0.35,
};

/** Curated base lexicon; extended per-user from icp.pain_signals (treated strong). */
export const STRONG_MARKERS = [
  "looking for",
  "recommend",
  "recommendations",
  "anyone use",
  "anyone using",
  "alternative to",
  "switching from",
  "need a",
  "need an",
  "what do you use",
  "best tool for",
  "help me find",
  "can anyone recommend",
  "in the market for",
  "looking to buy",
  "any recommendations",
  "who do you use",
  "suggestions for",
];
export const MEDIUM_MARKERS = [
  "frustrated with",
  "hate that",
  "why is",
  "so hard",
  "any tips",
  "comparing",
  "worth it",
  "fed up",
  "struggling with",
  "tired of",
  "sick of",
  "wish there was",
];
const INTERROGATIVES = ["how", "what", "which", "who", "where", "anyone", "does", "should", "can", "any", "is there"];

// Component weights (sum = 1.0). Module-level consts, calibrated live like the
// trend BUZZ/NICHE thresholds. Marker + provenance dominate: the wording and the
// query bucket are the strongest intent evidence.
const W_MARKER = 0.3;
const W_PROVENANCE = 0.2;
const W_QUESTION = 0.1;
const W_COMPETITOR = 0.1;
const W_RECENCY = 0.15;
const W_REACHABILITY = 0.05;
const W_CROWDING = 0.1;

/** Replies past which a thread is "a lost race" for a timely reply. */
const CROWD_SATURATION = 80;

export interface IntentCandidate {
  text: string;
  authorFollowers: number;
  replyCount: number;
  createdAt: Date;
  /** Which discovery bucket surfaced it — deterministic, known before scoring. */
  provenance: IntentType;
}

export interface IcpScoringContext {
  competitorTerms: string[];
  /** Per-user pain phrasings, folded into the strong-marker lexicon. */
  painSignals: string[];
  /** Contexts that are NOT the buyer — any hit hard-drops the candidate. */
  exclusions: string[];
  /** Recency decays over this window (from config.BUYER_LOOKBACK_HOURS). */
  lookbackHours: number;
  /** For a deterministic, testable recency curve; defaults to Date.now(). */
  now?: number;
}

export interface IntentComponents {
  marker: number;
  provenance: number;
  question: number;
  competitor: number;
  recency: number;
  reachability: number;
  crowding: number;
  excluded: boolean;
}

export interface IntentResult {
  score: number;
  intent_type: IntentType;
  components: IntentComponents;
}

const norm = (s: string): string => s.toLowerCase();
const has = (hay: string, needle: string): boolean => needle.length > 0 && hay.includes(norm(needle));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Follower "sweet spot" band — NOT monotonic. A mid-size real account beats both
 * a 12-follower egg and a 500k-follower account tweeting rhetorically. Buyers
 * with genuine reach-to-convert sit in the middle.
 */
export function reachabilityBand(followers: number): number {
  const f = Math.max(0, followers);
  if (f < 50) return 0.1; // egg / bot-shaped
  if (f < 1000) return 0.2 + (0.8 * (f - 50)) / (1000 - 50); // ramp 0.2 → 1.0
  if (f <= 50_000) return 1.0; // the band
  if (f <= 500_000) return 1.0 - (0.7 * (f - 50_000)) / (500_000 - 50_000); // decay 1.0 → 0.3
  return 0.2; // megaphone account, likely rhetorical
}

function markerStrength(text: string, painSignals: string[]): number {
  const strong = [...STRONG_MARKERS, ...painSignals.map(norm)];
  const strongHits = strong.filter((m) => has(text, m)).length;
  if (strongHits >= 1) return Math.min(1, 0.75 + 0.1 * (strongHits - 1));
  const mediumHits = MEDIUM_MARKERS.filter((m) => has(text, m)).length;
  if (mediumHits >= 1) return Math.min(0.6, 0.35 + 0.08 * (mediumHits - 1));
  return 0.05;
}

function questionScore(text: string): number {
  if (text.includes("?")) return 1.0;
  const opener = text.trimStart().split(/\s+/, 1)[0] ?? "";
  if (INTERROGATIVES.includes(opener)) return 0.7;
  return 0.2;
}

function recencyScore(createdAt: Date, lookbackHours: number, now: number): number {
  const ageHours = (now - createdAt.getTime()) / 3_600_000;
  const base = Math.max(0, 1 - ageHours / Math.max(1, lookbackHours));
  return base * base; // steep decay — a stale "looking for" is likely resolved
}

function crowdingScore(replyCount: number): number {
  // INVERSE of buzz: fewer existing replies → higher. Saturates to 0 at ~80.
  const c = 1 - Math.log10(Math.max(0, replyCount) + 1) / Math.log10(CROWD_SATURATION + 1);
  return Math.max(0, Math.min(1, c));
}

/**
 * Score a candidate's purchase intent against the ICP. Returns the score, the
 * intent_type (the surfacing bucket), and the full component breakdown so
 * surfacing payloads stay inspectable (never a black box). An exclusion hit is a
 * hard kill (score 0) regardless of every other component.
 */
export function intentScore(candidate: IntentCandidate, icp: IcpScoringContext): IntentResult {
  const text = norm(candidate.text);
  const excluded = icp.exclusions.some((e) => has(text, e));

  const components: IntentComponents = {
    marker: excluded ? 0 : markerStrength(text, icp.painSignals),
    provenance: PROVENANCE_WEIGHT[candidate.provenance],
    question: excluded ? 0 : questionScore(text),
    competitor: !excluded && icp.competitorTerms.some((c) => has(text, c)) ? 1 : 0,
    recency: recencyScore(candidate.createdAt, icp.lookbackHours, icp.now ?? Date.now()),
    reachability: reachabilityBand(candidate.authorFollowers),
    crowding: crowdingScore(candidate.replyCount),
    excluded,
  };

  const score = excluded
    ? 0
    : round3(
        components.marker * W_MARKER +
          components.provenance * W_PROVENANCE +
          components.question * W_QUESTION +
          components.competitor * W_COMPETITOR +
          components.recency * W_RECENCY +
          components.reachability * W_REACHABILITY +
          components.crowding * W_CROWDING,
      );

  return { score, intent_type: candidate.provenance, components };
}
