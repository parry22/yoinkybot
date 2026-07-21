import { config } from "../config.js";
import { queryOne } from "../db/pool.js";
import type { Platform } from "../lib/types.js";

/**
 * Publishing — the write half of the social integration. Everything else in
 * this codebase READS platforms (Apify / twitterapi.io scrape by handle, no
 * auth). This posts on the user's behalf, which needs a user-context OAuth
 * token stored on connected_accounts by the write-scope OAuth flow
 * (routes/oauth.ts). No token → publishing fails closed; scheduling and the
 * commands still work, the post just can't go out until the account is
 * connected for posting.
 *
 * These call the official platform APIs directly (endpoints/scopes are public
 * facts). Written to a small PublishResult contract so the scheduler treats a
 * platform 4xx and a missing token the same way: mark failed, tell the user why.
 */

const PUBLISH_TIMEOUT_MS = 15_000;

export interface WriteAuth {
  accessToken: string;
  authorUrn: string | null; // LinkedIn requires the member URN as post author
}

export interface PublishResult {
  ok: boolean;
  externalId?: string;
  url?: string;
  error?: string;
}

/** Whether this instance even has the app credentials to post to a platform. */
export function publishConfigured(platform: Platform): boolean {
  return platform === "x"
    ? !!(config.X_CLIENT_ID && config.X_CLIENT_SECRET)
    : !!(config.LINKEDIN_CLIENT_ID && config.LINKEDIN_CLIENT_SECRET);
}

/** Load the stored write token for a user's connected account, if any. */
export async function resolveWriteAuth(userId: string, platform: Platform): Promise<WriteAuth | null> {
  const row = await queryOne<{ post_access_token: string | null; post_author_urn: string | null }>(
    `SELECT post_access_token, post_author_urn FROM connected_accounts
     WHERE user_id = $1 AND platform = $2`,
    [userId, platform],
  );
  if (!row?.post_access_token) return null;
  return { accessToken: row.post_access_token, authorUrn: row.post_author_urn };
}

async function publishToX(auth: WriteAuth, content: string): Promise<PublishResult> {
  try {
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: content }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }; detail?: string; title?: string };
    if (!res.ok || !body.data?.id) {
      return { ok: false, error: `X API ${res.status}: ${body.detail ?? body.title ?? "post rejected"}` };
    }
    const id = body.data.id;
    return { ok: true, externalId: id, url: `https://x.com/i/web/status/${id}` };
  } catch (err) {
    return { ok: false, error: `X request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function publishToLinkedIn(auth: WriteAuth, content: string): Promise<PublishResult> {
  if (!auth.authorUrn) {
    return { ok: false, error: "LinkedIn author URN missing — reconnect the account for posting." };
  }
  try {
    const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: auth.authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: content },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    const id = body.id ?? res.headers.get("x-restli-id") ?? undefined;
    if (!res.ok || !id) {
      return { ok: false, error: `LinkedIn API ${res.status}: ${body.message ?? "post rejected"}` };
    }
    return { ok: true, externalId: id, url: `https://www.linkedin.com/feed/update/${id}` };
  } catch (err) {
    return { ok: false, error: `LinkedIn request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Publish `content` to `platform` using the account's stored write auth. */
export async function publish(auth: WriteAuth, platform: Platform, content: string): Promise<PublishResult> {
  return platform === "x" ? publishToX(auth, content) : publishToLinkedIn(auth, content);
}
