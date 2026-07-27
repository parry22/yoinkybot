import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { publishConfigured } from "../social/publish.js";
import { afterOAuthConnected } from "../telegram/connect-auth.js";
import type { Platform } from "../lib/types.js";

/**
 * The user-context OAuth flow — the ONLY place Yoinky asks the user to
 * authorize their account. It serves two purposes with one consent:
 *   - onboarding connect (telegram/connect-auth.ts): proves account ownership,
 *     resolves the verified X handle via users.read, and gates the history read
 *     on demonstrated consent instead of a typed handle;
 *   - posting (social/publish.ts): the stored write token publishes scheduled
 *     posts on the user's behalf.
 * Two legs:
 *   GET /oauth/:platform/start     → redirect the user to the platform's consent
 *   GET /oauth/:platform/callback  → exchange the code, store the token, then
 *     hand off to afterOAuthConnected (Telegram follow-through + ingest kick).
 *
 * CREDENTIAL-GATED + NOT LIVE-TESTED: this needs real app credentials
 * (X_CLIENT_ID/SECRET with a paid X tier for tweet.write; LINKEDIN_CLIENT_ID/
 * SECRET with an approved w_member_social app). Without them every route here
 * returns 503. The flow follows the platforms' documented OAuth 2.0 exactly,
 * but has not been exercised against the live providers — verify end-to-end
 * once credentials exist before relying on it.
 *
 * PKCE verifier + which-user are held in an in-memory map keyed by the opaque
 * `state`, with a short TTL. This app is single-instance by design (see
 * docs/INTERNAL.md), so the map is sufficient and avoids a table for a
 * 10-minute handshake; if this ever scales horizontally, move it to Postgres.
 */

interface PendingAuth {
  userId: string;
  platform: Platform;
  verifier: string;
  expiresAt: number;
  /** Web caller's return URL (only ever set when it matched WEB_APP_URL — see
   *  `safeReturnTo`). Undefined for the Telegram-only flow, which keeps the
   *  original static "return to Telegram" page. */
  returnTo?: string;
}

/** Only ever honor a `redirect` that's on the web app's own trusted origin —
 *  this is a browser redirect target after OAuth, so an unbounded value here
 *  would be an open-redirect vector. */
function safeReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.startsWith(config.WEB_APP_URL) ? raw : undefined;
}
const pending = new Map<string, PendingAuth>();
const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [state, p] of pending) if (p.expiresAt < now) pending.delete(state);
}

const REDIRECT = (platform: Platform) => `${config.PUBLIC_URL}/oauth/${platform}/callback`;

/**
 * Build the consent URL the user must open to grant posting access, stashing
 * the PKCE verifier under an opaque state. Returns null when this platform's
 * app credentials aren't configured. Called by the bot to hand the user a link.
 */
export function buildAuthUrl(userId: string, platform: Platform, returnTo?: string): string | null {
  if (!publishConfigured(platform)) return null;
  sweepExpired();
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  pending.set(state, { userId, platform, verifier, expiresAt: Date.now() + STATE_TTL_MS, returnTo: safeReturnTo(returnTo) });

  if (platform === "x") {
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.X_CLIENT_ID!,
      redirect_uri: REDIRECT("x"),
      // media.write is what lets a scheduled post carry an image or video
      // (social/media.ts). Tokens minted BEFORE this scope was added don't have
      // it, so an existing connection can post text but will fail on media until
      // the user reconnects — the scheduler says so rather than failing silently.
      //
      // offline.access is what returns a refresh token. X's access tokens last
      // ~2 hours, so without renewal almost every scheduled post would fire
      // against a dead one; social/publish.ts#ensureWriteAuth spends the refresh
      // token before each publish. A connection made without this scope has no
      // refresh token and is treated as needing re-consent once it expires.
      scope: "tweet.read tweet.write users.read media.write offline.access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // X migrated off twitter.com — the old twitter.com/i/oauth2/authorize path
    // now 404s. x.com is the live consent endpoint.
    return `https://x.com/i/oauth2/authorize?${params}`;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.LINKEDIN_CLIENT_ID!,
    redirect_uri: REDIRECT("linkedin"),
    scope: "w_member_social openid profile",
    state,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

/** Persist the write token on the (user, platform) connected_accounts row. */
async function storeToken(
  userId: string,
  platform: Platform,
  tok: { accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string; authorUrn?: string },
): Promise<void> {
  const expiresAt = tok.expiresIn ? new Date(Date.now() + tok.expiresIn * 1000).toISOString() : null;
  await query(
    `INSERT INTO connected_accounts (user_id, platform, handle, status,
        post_access_token, post_refresh_token, post_token_expires_at, post_scopes, post_author_urn)
     VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, platform) DO UPDATE SET
        post_access_token = EXCLUDED.post_access_token,
        post_refresh_token = EXCLUDED.post_refresh_token,
        post_token_expires_at = EXCLUDED.post_token_expires_at,
        post_scopes = EXCLUDED.post_scopes,
        -- Re-consenting IS the fix for a dead credential, so clear the flag the
        -- publisher sets when it gives up on one (social/publish.ts). Leaving it
        -- set would keep telling the user to reconnect an account they just did.
        post_reauth_required_at = NULL,
        post_author_urn = COALESCE(EXCLUDED.post_author_urn, connected_accounts.post_author_urn)`,
    [userId, platform, "connected-for-posting", tok.accessToken, tok.refreshToken ?? null, expiresAt, tok.scope ?? null, tok.authorUrn ?? null],
  );
}

async function exchangeX(code: string, verifier: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT("x"),
    code_verifier: verifier,
    client_id: config.X_CLIENT_ID!,
  });
  const basic = Buffer.from(`${config.X_CLIENT_ID}:${config.X_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !json.access_token) throw new Error(`X token exchange ${res.status}`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in, scope: json.scope };
}

async function exchangeLinkedIn(code: string): Promise<{ accessToken: string; expiresIn?: number; authorUrn?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT("linkedin"),
    client_id: config.LINKEDIN_CLIENT_ID!,
    client_secret: config.LINKEDIN_CLIENT_SECRET!,
  });
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) throw new Error(`LinkedIn token exchange ${res.status}`);
  // The post author URN comes from the OpenID userinfo endpoint (sub = member id).
  const who = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${json.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const info = (await who.json().catch(() => ({}))) as { sub?: string };
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    authorUrn: info.sub ? `urn:li:person:${info.sub}` : undefined,
  };
}

const DONE_HTML = (msg: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${msg}</p><p>You can close this tab and return to Telegram.</p></body>`;

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { platform: string }; Querystring: { u?: string; redirect?: string } }>(
    "/oauth/:platform/start",
    async (req, reply) => {
      const platform = req.params.platform as Platform;
      if (platform !== "x" && platform !== "linkedin") return reply.code(404).send("unknown platform");
      const userId = req.query.u;
      if (!userId) return reply.code(400).send("missing user");
      const url = buildAuthUrl(userId, platform, req.query.redirect);
      if (!url) return reply.code(503).send(`${platform} posting isn't configured on this instance`);
      return reply.redirect(url);
    },
  );

  app.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/:platform/callback",
    async (req, reply) => {
      const platform = req.params.platform as Platform;
      if (platform !== "x" && platform !== "linkedin") return reply.code(404).send("unknown platform");
      const { code, state, error } = req.query;
      if (error) return reply.type("text/html").send(DONE_HTML(`Authorization was cancelled (${error}).`));
      if (!code || !state) return reply.code(400).send("missing code/state");

      const pend = pending.get(state);
      pending.delete(state);
      if (!pend || pend.platform !== platform || pend.expiresAt < Date.now()) {
        return reply.type("text/html").send(DONE_HTML("That link expired — start the connect again from the bot."));
      }

      let accessToken: string;
      try {
        if (platform === "x") {
          const tok = await exchangeX(code, pend.verifier);
          await storeToken(pend.userId, "x", tok);
          accessToken = tok.accessToken;
        } else {
          const tok = await exchangeLinkedIn(code);
          await storeToken(pend.userId, "linkedin", tok);
          accessToken = tok.accessToken;
        }
      } catch (err) {
        req.log.error({ err }, "oauth token exchange failed");
        if (pend.returnTo) {
          const back = new URL(pend.returnTo);
          back.searchParams.set("connect_error", "1");
          return reply.redirect(back.toString());
        }
        return reply.type("text/html").send(DONE_HTML("Something went wrong connecting your account. Try again from the bot."));
      }
      // Follow-through happens in Telegram (verify identity, kick the history
      // ingest, offer the next platform) — failures there must never turn a
      // stored token into an error page, so it runs detached from this response.
      void afterOAuthConnected(pend.userId, platform, accessToken).catch((err) =>
        req.log.error({ err }, "oauth follow-through failed"),
      );
      // A web caller gets bounced straight back to its own origin (Settings) —
      // the Telegram-flavored static page below is only for the bot's own flow.
      if (pend.returnTo) {
        const back = new URL(pend.returnTo);
        back.searchParams.set("connected", platform);
        return reply.redirect(back.toString());
      }
      return reply.type("text/html").send(DONE_HTML(`Your ${platform === "x" ? "X" : "LinkedIn"} account is connected. ✅ I've picked things up in Telegram.`));
    },
  );
}
