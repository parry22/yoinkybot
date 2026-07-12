import { PostHog } from "posthog-node";
import { config } from "../config.js";

/**
 * Product analytics — server-side PostHog. This is a Telegram-native backend
 * with no web frontend, so there is no browser snippet or autocapture: every
 * event is captured explicitly at a product choke point (see the callers of
 * `track`), keyed by the internal user id (`users.id`), which is stable across
 * a user's whole lifetime unlike the Telegram id.
 *
 * Gated on POSTHOG_API_KEY: with no key, the client is never constructed and
 * `track`/`identify` are silent no-ops — same graceful-degradation contract as
 * every other optional integration here. Nothing user-facing ever depends on
 * analytics succeeding, so every call is wrapped and swallows its own errors:
 * a metrics outage must never break a product action.
 */

let client: PostHog | null = null;
let initialized = false;

function getClient(): PostHog | null {
  if (initialized) return client;
  initialized = true;
  if (!config.POSTHOG_API_KEY) return null;
  client = new PostHog(config.POSTHOG_API_KEY, {
    host: config.POSTHOG_HOST,
    // Server-side + low volume: flush on a short timer so events aren't stranded
    // for long on a single-instance deploy, but batch enough to not fire an HTTP
    // request per event.
    flushAt: 20,
    flushInterval: 10_000,
  });
  return client;
}

/** Whether analytics is actually wired (key present) — for /health, not gating. */
export function analyticsEnabled(): boolean {
  return !!config.POSTHOG_API_KEY;
}

/**
 * Record a product event. `distinctId` is the internal user id. `properties`
 * must be metadata only (platform, source, plan, counts) — never raw user
 * content (post text, captured thoughts): those don't belong in an analytics
 * store. No-op + swallow on any failure.
 */
export function track(distinctId: string, event: string, properties?: Record<string, unknown>): void {
  const c = getClient();
  if (!c) return;
  try {
    c.capture({ distinctId, event, properties });
  } catch (err) {
    console.error(`posthog track failed (${event})`, err);
  }
}

/** Set person properties for a user (stage, plan, connected platforms, …). */
export function identify(distinctId: string, properties: Record<string, unknown>): void {
  const c = getClient();
  if (!c) return;
  try {
    c.identify({ distinctId, properties });
  } catch (err) {
    console.error("posthog identify failed", err);
  }
}

/** Flush + close on graceful shutdown so in-flight events aren't lost on deploy. */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    console.error("posthog shutdown failed", err);
  }
}
