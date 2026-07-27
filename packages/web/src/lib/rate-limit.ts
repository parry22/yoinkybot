import "server-only";
import { consumeRateLimit, rateLimitMessage, type RateLimitBucket } from "@yoink/backend/web";

/**
 * The web-side burst guard. Sits directly under `requirePaid` on every route
 * that spends real money (model calls, twitterapi.io, Apify) or reaches the
 * operator's inbox.
 *
 * Returns a ready-to-return 429 `Response` when the caller is over the limit,
 * or null when they may proceed — same shape as the paywall check above it, so
 * a route reads:
 *
 *   const limited = await rateLimited(user.id, "chat");
 *   if (limited) return limited;
 *
 * The body uses `error` like every other rejection here, so the existing client
 * error paths (useAgentStream's pre-stream branch, the fetch handlers) surface
 * the message with no change. `Retry-After` is set for well-behaved clients.
 */
export async function rateLimited(userId: string, bucket: RateLimitBucket): Promise<Response | null> {
  const res = await consumeRateLimit(userId, bucket);
  if (res.ok) return null;
  return Response.json(
    { error: rateLimitMessage(res.retryAfterSec), retryAfter: res.retryAfterSec },
    { status: 429, headers: { "retry-after": String(res.retryAfterSec) } },
  );
}
