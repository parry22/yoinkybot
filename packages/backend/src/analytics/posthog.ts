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

/**
 * Erase a user's analytics person on account wipe, so `clear_everything`'s
 * "delete everything" promise also covers PostHog, not just our own DB. Uses the
 * async bulk-delete API (deletes the person AND all their events). Best-effort
 * and config-gated: a no-op unless a personal API key + project id are set, and
 * it swallows every failure — a wipe must never fail because analytics erasure
 * did. Keyed by the same internal user id used as distinctId in `track`.
 */
export async function deletePerson(distinctId: string): Promise<void> {
  const key = config.POSTHOG_PERSONAL_API_KEY;
  const project = config.POSTHOG_PROJECT_ID;
  if (!key || !project) return;
  try {
    await fetch(`${config.POSTHOG_HOST}/api/projects/${project}/persons/bulk_delete/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ distinct_ids: [distinctId], delete_events: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("posthog person delete failed (analytics may retain events for this user)", err);
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
