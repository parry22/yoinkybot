/**
 * Web "Sign in with X" / "Connect X" finalizer. The web app runs the X OAuth
 * handshake in its own Next routes (so it can set the session cookie on its own
 * origin); once it has the token + identity it calls this to persist the posting
 * token and kick the history read (ingest + diagnosis), exactly like the bot's
 * `afterOAuthConnected` does. Reused by both sign-in (new user) and the
 * mandatory connect popup (existing session).
 */
import { query } from "../db/pool.js";
import { config } from "../config.js";
import { ensureBoss } from "../jobs/boss.js";
import { startConnect } from "../strategist/connect.js";

export interface XConnectStatus {
  /**
   * A usable X connection: the account row exists AND its history read hasn't
   * failed. This used to be a bare `Boolean(row)`, which counted a `failed` row
   * as fully connected — the web gate then didn't fire and the user sat in an
   * empty app forever with nothing telling them the read had died.
   */
  connected: boolean;
  status: string | null; // pending | ingesting | ingested | failed | null
  /** The history read is queued or running — connected, but there's no data yet. */
  reading: boolean;
  /** The history read failed (private/near-empty account, bad handle, or the pull errored). */
  failed: boolean;
  postCount: number;
}

/** Store the X posting token, then kick the scrape+diagnose job. */
export async function finalizeXConnect(
  userId: string,
  x: { handle: string; accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string },
): Promise<void> {
  const expiresAt = x.expiresIn ? new Date(Date.now() + x.expiresIn * 1000).toISOString() : null;
  await query(
    `INSERT INTO connected_accounts (user_id, platform, handle, status,
        post_access_token, post_refresh_token, post_token_expires_at, post_scopes)
     VALUES ($1,'x',$2,'pending',$3,$4,$5,$6)
     ON CONFLICT (user_id, platform) DO UPDATE SET
        handle = EXCLUDED.handle,
        post_access_token = EXCLUDED.post_access_token,
        post_refresh_token = EXCLUDED.post_refresh_token,
        post_token_expires_at = EXCLUDED.post_token_expires_at,
        post_scopes = EXCLUDED.post_scopes`,
    [userId, x.handle, x.accessToken, x.refreshToken ?? null, expiresAt, x.scope ?? null],
  );
  // The read (ingest + diagnosis) is processed by the backend worker; the web
  // only enqueues it. startConnect keeps the stored token (its upsert only
  // touches handle + status).
  await ensureBoss();
  if (config.TWITTERAPI_IO_KEY || config.APIFY_TOKEN) {
    await startConnect(userId, "x", x.handle).catch((err) => console.error("startConnect after X connect failed", err));
  }
}

/** Store a LinkedIn member write token. OpenID does not expose the vanity
 * profile URL the public-history actor needs, so history connection remains a
 * separate one-line URL action in Settings while publishing works immediately. */
export async function finalizeLinkedInConnect(
  userId: string,
  linkedIn: { accessToken: string; authorUrn: string; expiresIn?: number; displayName?: string },
): Promise<void> {
  const expiresAt = linkedIn.expiresIn ? new Date(Date.now() + linkedIn.expiresIn * 1000).toISOString() : null;
  await query(
    `INSERT INTO connected_accounts
       (user_id, platform, handle, status, post_access_token, post_token_expires_at, post_scopes, post_author_urn)
     VALUES ($1,'linkedin',$2,'posting_connected',$3,$4,'w_member_social openid profile',$5)
     ON CONFLICT (user_id, platform) DO UPDATE SET
       post_access_token = EXCLUDED.post_access_token,
       post_token_expires_at = EXCLUDED.post_token_expires_at,
       post_scopes = EXCLUDED.post_scopes,
       post_author_urn = EXCLUDED.post_author_urn,
       post_reauth_required_at = NULL`,
    [userId, linkedIn.displayName?.trim() || "connected-for-posting", linkedIn.accessToken, expiresAt, linkedIn.authorUrn],
  );
}

export async function connectLinkedInProfileFromWeb(userId: string, profileUrl: string): Promise<void> {
  const value = profileUrl.trim();
  if (!/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]+\/?(?:\?.*)?$/i.test(value)) {
    throw new Error("Paste a full LinkedIn profile URL, like https://www.linkedin.com/in/your-name");
  }
  if (!config.APIFY_TOKEN) throw new Error("LinkedIn profile reading isn't configured on this instance");
  await ensureBoss();
  await startConnect(userId, "linkedin", value);
}

/** Read the current X connection/ingest state for the mandatory-connect popup poll. */
export async function getXConnectStatus(userId: string): Promise<XConnectStatus> {
  const row = await query<{ status: string; post_count: number }>(
    `SELECT status, post_count FROM connected_accounts WHERE user_id = $1 AND platform = 'x' LIMIT 1`,
    [userId],
  );
  const r = row[0];
  const status = r?.status ?? null;
  const failed = status === "failed";
  // 'pending' is also the state a connect gets stuck in when no scrape provider
  // is configured (finalizeXConnect only enqueues the read when a key exists),
  // so it must read as "still working", never as "done".
  const reading = status === "pending" || status === "ingesting";
  return { connected: Boolean(r) && !failed, status, reading, failed, postCount: r?.post_count ?? 0 };
}
