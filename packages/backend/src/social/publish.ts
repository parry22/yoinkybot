import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import type { Platform } from "../lib/types.js";

/**
 * Publishing - the write half of the social integration. Everything else in
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
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * Renew this long before the stored token actually expires. A publish can take
 * minutes (a video transcodes between the upload and the post call), so a token
 * with four minutes left is a token that will expire mid-flight.
 */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface WriteAuth {
  accessToken: string;
  authorUrn: string | null; // LinkedIn requires the member URN as post author
}

export interface PublishResult {
  ok: boolean;
  externalId?: string;
  url?: string;
  error?: string;
  /** The platform answered 401 - the credential is dead, not the request. The
   *  caller marks the connection as needing re-consent so the UI can say so. */
  authExpired?: boolean;
}

/** Whether this instance even has the app credentials to post to a platform. */
export function publishConfigured(platform: Platform): boolean {
  return platform === "x"
    ? !!(config.X_CLIENT_ID && config.X_CLIENT_SECRET)
    : !!(config.LINKEDIN_CLIENT_ID && config.LINKEDIN_CLIENT_SECRET);
}

/**
 * Load the stored write token as-is - no expiry check, no refresh. This is the
 * "has this account ever been connected for posting?" read (the Telegram
 * scheduling confirmation uses it to warn up front). Anything that is about to
 * actually call a platform API must use `ensureWriteAuth` instead.
 */
export async function resolveWriteAuth(userId: string, platform: Platform): Promise<WriteAuth | null> {
  const row = await queryOne<{ post_access_token: string | null; post_author_urn: string | null }>(
    `SELECT post_access_token, post_author_urn FROM connected_accounts
     WHERE user_id = $1 AND platform = $2`,
    [userId, platform],
  );
  if (!row?.post_access_token) return null;
  return { accessToken: row.post_access_token, authorUrn: row.post_author_urn };
}

// ── Token lifecycle ─────────────────────────────────────────────────────────
//
// X's OAuth 2.0 user-context access tokens live ~2 hours. The connect flow has
// always asked for `offline.access` and stored post_refresh_token +
// post_token_expires_at, but until now NOTHING read either column: the publisher
// took post_access_token verbatim, so any post scheduled more than two hours
// after the user connected went out against a dead token and came back 401 with
// "post rejected" as the only explanation. Refreshing before every publish is
// the fix; the rest of this section is about the case refresh can't fix.
//
// LinkedIn is different on purpose. Its access tokens last 60 days and its
// refresh grant is only issued to approved partner apps, so there is no renewal
// path to attempt here - an expired LinkedIn token can only be replaced by the
// user re-consenting, and that is exactly what `needs_reauth` reports.

export type WriteAuthResolution =
  | { ok: true; auth: WriteAuth }
  /** Never connected for posting, or the credential is gone. */
  | { ok: false; reason: "not_connected"; detail: string }
  /** Was connected; the credential died and only the user can restore it. */
  | { ok: false; reason: "needs_reauth"; detail: string }
  /** The token endpoint itself was unreachable/5xx - worth retrying later. */
  | { ok: false; reason: "refresh_failed"; detail: string };

/** Connection state for the UI: is posting wired up, and is it broken? */
export interface WriteAuthState {
  connected: boolean;
  needsReauth: boolean;
}

export async function writeAuthState(userId: string, platform: Platform): Promise<WriteAuthState> {
  const row = await queryOne<{ post_access_token: string | null; post_reauth_required_at: string | null }>(
    `SELECT post_access_token, post_reauth_required_at FROM connected_accounts
     WHERE user_id = $1 AND platform = $2`,
    [userId, platform],
  );
  return {
    connected: !!row?.post_access_token,
    // A live token supersedes the flag - see markWriteAuthDead for why the two
    // can never both be true for a credential that actually works.
    needsReauth: !row?.post_access_token && !!row?.post_reauth_required_at,
  };
}

/**
 * Record that the stored credential is dead and only re-consent can fix it.
 *
 * The token is CLEARED, not just flagged. Keeping a known-rejected access token
 * around would mean every later publish burns a doomed round-trip against it,
 * and it would make "connected for posting" read true when it isn't. Clearing it
 * also gives the flag an unambiguous meaning: a row with a token AND the flag set
 * can only be one that was reconnected after the flag, so the flag is stale and
 * safe to drop (see ensureWriteAuth).
 */
export async function markWriteAuthDead(userId: string, platform: Platform): Promise<void> {
  await query(
    `UPDATE connected_accounts
        SET post_access_token = NULL, post_refresh_token = NULL,
            post_token_expires_at = NULL, post_reauth_required_at = now()
      WHERE user_id = $1 AND platform = $2`,
    [userId, platform],
  );
}

async function clearReauthFlag(userId: string, platform: Platform): Promise<void> {
  await query(
    `UPDATE connected_accounts SET post_reauth_required_at = NULL
      WHERE user_id = $1 AND platform = $2 AND post_reauth_required_at IS NOT NULL`,
    [userId, platform],
  );
}

type XRefreshOutcome =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string | null }
  /** `permanent` distinguishes "X rejected this refresh token" (the user must
   *  reconnect) from "X was down / the network failed" (try again later). */
  | { ok: false; permanent: boolean; detail: string };

/**
 * Exchange a refresh token for a new access token, using the same confidential-
 * client credentials and token endpoint as the authorization-code leg in
 * routes/oauth.ts. X rotates the refresh token on every use, so the response's
 * refresh_token must be persisted or the NEXT refresh fails.
 */
async function refreshXToken(refreshToken: string): Promise<XRefreshOutcome> {
  const basic = Buffer.from(`${config.X_CLIENT_ID}:${config.X_CLIENT_SECRET}`).toString("base64");
  let res: Response;
  try {
    res = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.X_CLIENT_ID!,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, permanent: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `token endpoint ${res.status}`;
    // 4xx means the grant itself was refused (revoked, already-rotated, or the
    // app's access changed). 5xx/429 is X having a bad minute - don't throw away
    // a working credential over that.
    return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429, detail };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresIn: body.expires_in ?? null,
    scope: body.scope ?? null,
  };
}

/**
 * The write token to actually publish with: stored, refreshed if it's expired or
 * about to be, and reported as needing re-consent when it can't be renewed.
 *
 * Everything that calls a platform write API goes through this. Callers get a
 * reason rather than a bare null so they can tell the user the true difference
 * between "you never connected X" and "your X connection expired".
 */
export async function ensureWriteAuth(userId: string, platform: Platform): Promise<WriteAuthResolution> {
  const row = await queryOne<{
    post_access_token: string | null;
    post_refresh_token: string | null;
    post_token_expires_at: string | null;
    post_author_urn: string | null;
    post_reauth_required_at: string | null;
  }>(
    `SELECT post_access_token, post_refresh_token, post_token_expires_at,
            post_author_urn, post_reauth_required_at
       FROM connected_accounts WHERE user_id = $1 AND platform = $2`,
    [userId, platform],
  );
  const label = platform === "x" ? "X" : "LinkedIn";

  if (!row?.post_access_token) {
    return row?.post_reauth_required_at
      ? { ok: false, reason: "needs_reauth", detail: `${label} connection expired - reconnect ${label} to publish` }
      : { ok: false, reason: "not_connected", detail: `${label} not connected for posting` };
  }
  // A stored token alongside a set flag means the user reconnected after we gave
  // up on the old credential (markWriteAuthDead clears the token when it sets the
  // flag), so the flag is stale. Best-effort: a failure here costs a wrong UI
  // banner, never a missed post.
  if (row.post_reauth_required_at) await clearReauthFlag(userId, platform).catch(() => {});

  const expiresAt = row.post_token_expires_at ? Date.parse(row.post_token_expires_at) : NaN;
  // No recorded expiry (tokens stored before this column was populated) → use it
  // and let a 401 be the source of truth. Better a wasted call than refusing to
  // post with a token that may well be fine.
  const expiring = Number.isFinite(expiresAt) && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS;
  if (!expiring) return { ok: true, auth: { accessToken: row.post_access_token, authorUrn: row.post_author_urn } };

  if (platform !== "x" || !row.post_refresh_token) {
    // LinkedIn has no refresh grant for standard apps; an X token minted before
    // `offline.access` was requested has no refresh token to spend either.
    await markWriteAuthDead(userId, platform);
    return {
      ok: false,
      reason: "needs_reauth",
      detail: `${label} connection expired - reconnect ${label} to publish`,
    };
  }

  const refreshed = await refreshXToken(row.post_refresh_token);
  if (!refreshed.ok) {
    if (!refreshed.permanent) {
      return { ok: false, reason: "refresh_failed", detail: `couldn't renew the ${label} token: ${refreshed.detail}` };
    }
    await markWriteAuthDead(userId, platform);
    return {
      ok: false,
      reason: "needs_reauth",
      detail: `${label} connection expired - reconnect ${label} to publish (${refreshed.detail})`,
    };
  }

  await query(
    `UPDATE connected_accounts
        SET post_access_token = $3,
            -- X rotates the refresh token on use; COALESCE keeps the old one only
            -- for the (undocumented but possible) response that omits a new one.
            post_refresh_token = COALESCE($4, post_refresh_token),
            post_token_expires_at = $5,
            post_scopes = COALESCE($6, post_scopes),
            post_reauth_required_at = NULL
      WHERE user_id = $1 AND platform = $2`,
    [
      userId,
      platform,
      refreshed.accessToken,
      refreshed.refreshToken,
      refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null,
      refreshed.scope,
    ],
  );
  return { ok: true, auth: { accessToken: refreshed.accessToken, authorUrn: row.post_author_urn } };
}

async function publishToX(auth: WriteAuth, content: string, mediaIds: string[] = []): Promise<PublishResult> {
  try {
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        mediaIds.length > 0 ? { text: content, media: { media_ids: mediaIds } } : { text: content },
      ),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }; detail?: string; title?: string };
    if (!res.ok || !body.data?.id) {
      return {
        ok: false,
        error: `X API ${res.status}: ${body.detail ?? body.title ?? "post rejected"}`,
        // 401 only: X answers 403 for a scope/permission problem, which a
        // reconnect with the same scopes would not fix.
        authExpired: res.status === 401,
      };
    }
    const id = body.data.id;
    return { ok: true, externalId: id, url: `https://x.com/i/web/status/${id}` };
  } catch (err) {
    return { ok: false, error: `X request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface PublishMedia {
  kind: "image" | "gif" | "video";
  altText: string | null;
}

async function publishToLinkedIn(
  auth: WriteAuth,
  content: string,
  mediaIds: string[],
  media: PublishMedia[],
): Promise<PublishResult> {
  if (!auth.authorUrn) {
    return { ok: false, error: "LinkedIn author URN missing - reconnect the account for posting." };
  }
  try {
    const postContent =
      mediaIds.length === 0
        ? undefined
        : mediaIds.length === 1
          ? { media: { id: mediaIds[0], altText: media[0]?.altText ?? "" } }
          : {
              multiImage: {
                images: mediaIds.map((id, index) => ({ id, altText: media[index]?.altText ?? "" })),
              },
            };
    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "Linkedin-Version": config.LINKEDIN_API_VERSION,
      },
      body: JSON.stringify({
        author: auth.authorUrn,
        lifecycleState: "PUBLISHED",
        commentary: content,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(postContent ? { content: postContent } : {}),
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    const id = body.id ?? res.headers.get("x-restli-id") ?? undefined;
    if (!res.ok || !id) {
      return {
        ok: false,
        error: `LinkedIn API ${res.status}: ${body.message ?? "post rejected"}`,
        authExpired: res.status === 401,
      };
    }
    return { ok: true, externalId: id, url: `https://www.linkedin.com/feed/update/${id}` };
  } catch (err) {
    return { ok: false, error: `LinkedIn request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Publish `content` to `platform` using the account's stored write auth.
 * `mediaIds` are platform media ids already uploaded by social/media.ts.
 */
export async function publish(
  auth: WriteAuth,
  platform: Platform,
  content: string,
  mediaIds: string[] = [],
  media: PublishMedia[] = [],
): Promise<PublishResult> {
  return platform === "x"
    ? publishToX(auth, content, mediaIds)
    : publishToLinkedIn(auth, content, mediaIds, media);
}
