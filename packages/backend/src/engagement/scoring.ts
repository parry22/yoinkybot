/**
 * Deterministic reply-worthiness scoring - pure functions, no I/O, no model.
 * Whether something deserves the user's attention is too consequential (trust
 * on one side, missed moments on the other) to leave to model judgment: the
 * model only ever drafts language for ONE mention that already cleared this bar.
 */

/** Spec weights for the reply-worthy combination. */
const W_REACH = 0.3;
const W_QUESTION = 0.3;
const W_CHALLENGE = 0.25;
const W_RELATIONSHIP = 0.15;

/** Starting surface bar before any feedback exists. */
export const BASE_THRESHOLD = 0.45;
const MIN_OUTCOMES_TO_LEARN = 5;
const THRESHOLD_CEILING = 0.85;
const THRESHOLD_FLOOR = 0.3;

/** Log-scale follower count into 0..1 - 1M+ followers saturates at 1. */
export function reachScore(followers: number): number {
  return Math.min(1, Math.log10(Math.max(0, followers) + 1) / 6);
}

/**
 * Interaction history stands in for the spec's connections table (which doesn't
 * exist yet): replies the user has actually sent this author weigh most, prior
 * mentions from them weigh some. Swap for a real relationship graph later.
 */
export function relationshipStrength(priorMentionsFromAuthor: number, repliesSentToAuthor: number): number {
  return Math.min(1, repliesSentToAuthor * 0.4 + priorMentionsFromAuthor * 0.15);
}

export interface MentionSignals {
  reach01: number; // reachScore(followers)
  isQuestion: boolean;
  isSubstantiveChallenge: boolean;
  relationship: number; // relationshipStrength(...)
}

export function replyWorthyScore(s: MentionSignals): number {
  const raw =
    s.reach01 * W_REACH +
    (s.isQuestion ? W_QUESTION : 0) +
    (s.isSubstantiveChallenge ? W_CHALLENGE : 0) +
    s.relationship * W_RELATIONSHIP;
  return Math.round(raw * 1000) / 1000;
}

export interface ReplyOutcome {
  score: number;
  status: "sent" | "skipped";
}

/**
 * The per-user learned surface bar. Skip-heavy feedback raises it to sit above
 * what they keep skipping; send-heavy feedback relaxes it slightly. Two failure
 * modes are deliberately NOT conflated: heavy pre-send editing is a VOICE
 * signal (tracked via sent_replies.edited_before_send), not a filtering signal,
 * so it never moves this threshold.
 */
export function learnedThreshold(outcomes: ReplyOutcome[]): number {
  const recent = outcomes.slice(0, 20);
  if (recent.length < MIN_OUTCOMES_TO_LEARN) return BASE_THRESHOLD;

  const skipped = recent.filter((o) => o.status === "skipped");
  const skipRate = skipped.length / recent.length;

  if (skipRate >= 0.7) {
    // They skip most of what we surface - sit just above the bulk of what they skipped.
    const scores = skipped.map((o) => o.score).sort((a, b) => a - b);
    const p75 = scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.75))]!;
    return Math.min(THRESHOLD_CEILING, Math.max(BASE_THRESHOLD, p75 + 0.02));
  }
  if (skipRate <= 0.4) {
    // They act on most drafts - the bar can relax a little.
    return Math.max(THRESHOLD_FLOOR, BASE_THRESHOLD - 0.05);
  }
  return BASE_THRESHOLD;
}

export interface RankableMention {
  id: string;
  isSubstantiveChallenge: boolean;
  isQuestion: boolean;
  score: number;
}

/**
 * Priority within a delivery slot, per spec: substantive challenges first
 * (silence looks worst there), then questions (ignoring one reads dismissive),
 * then plain score. One winner per slot - a queue, never a batch.
 */
export function pickNextMention<T extends RankableMention>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  const rank = (m: RankableMention) => (m.isSubstantiveChallenge ? 2 : 0) + (m.isQuestion ? 1 : 0);
  return [...candidates].sort((a, b) => rank(b) - rank(a) || b.score - a.score)[0]!;
}
