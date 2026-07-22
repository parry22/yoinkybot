/**
 * Source registry. Adding a third source type (viral_response, buyer_reply, …)
 * is implementing one selector + one entry here — the pipeline never changes.
 * Any future `per_user_paid` selector MUST add its own monthly budget gate before
 * wiring in (twitterapi.io has returned 402 in prod).
 */
import type { SourceType } from "../types.js";
import type { SourceSelector, CostProfile } from "./types.js";
import { selectTrendRide } from "./trend-ride.js";
import { selectUnlockBacklog } from "./unlock-backlog.js";

export const SOURCES: Record<SourceType, { select: SourceSelector; costProfile: CostProfile }> = {
  trend_ride: { select: selectTrendRide, costProfile: "shared_pool" },
  unlock_backlog: { select: selectUnlockBacklog, costProfile: "free_local" },
};
