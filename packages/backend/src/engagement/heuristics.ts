/**
 * Deterministic visibility/timing facts about a mention's thread - pure
 * functions, no I/O, no model. These exist so the reply-drafting agent reasons
 * over COMPUTED data instead of inventing algorithm folklore: the model gets
 * "reply #47, 3 hours in, conversation-heavy audience" as fact and decides how
 * to write for that moment; it never generates the numbers.
 */

/** A reply landing inside this window still rides the post's visibility peak. */
export const EARLY_WINDOW_MINUTES = 6 * 60;

export interface ThreadStats {
  /** ms epoch when the mention was posted. */
  postedAtMs: number;
  /** ms epoch now (injected for testability). */
  nowMs: number;
  /** Engagement counts on the mention tweet at lookup time; 0 when unknown. */
  replyCount: number;
  likeCount: number;
  retweetCount: number;
}

export interface EngagementHeuristics {
  /** How buried a new reply would land. */
  thread_reply_count: number;
  /** Freshness window. */
  minutes_since_post: number;
  /** Share of this post's engagement that is conversation (replies) rather than
   *  passive (likes/reposts) - does this poster's audience engage with replies. */
  op_reply_engagement_rate: number;
  /** Still inside the high-visibility window. */
  is_early_window: boolean;
}

export function minutesSincePost(postedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - postedAtMs) / 60_000));
}

export function opReplyEngagementRate(replyCount: number, likeCount: number, retweetCount: number): number {
  const total = replyCount + likeCount + retweetCount;
  if (total <= 0) return 0;
  return Math.round((replyCount / total) * 1000) / 1000;
}

export function computeHeuristics(s: ThreadStats): EngagementHeuristics {
  const minutes = minutesSincePost(s.postedAtMs, s.nowMs);
  return {
    thread_reply_count: Math.max(0, s.replyCount),
    minutes_since_post: minutes,
    op_reply_engagement_rate: opReplyEngagementRate(s.replyCount, s.likeCount, s.retweetCount),
    is_early_window: minutes < EARLY_WINDOW_MINUTES,
  };
}
