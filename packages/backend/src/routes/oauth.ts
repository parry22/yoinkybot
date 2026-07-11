import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { publishConfigured } from "../social/publish.js";
import type { Platform } from "../lib/types.js";

/**
 * Write-scope OAuth — the ONLY place Yoinky asks for permission to post as the
 * user (everything else reads public history by handle, no auth). Two legs:
 *   GET /oauth/:platform/start     → redirect the user to the platform's consent
 *   GET /oauth/:platform/callback  → exchange the code, store the write token
 * The stored token is what social/publish.ts uses when a scheduled post is due.
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
export function buildAuthUrl(userId: string, platform: Platform): string | null {
  if (!publishConfigured(platform)) return null;
  sweepExpired();
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  pending.set(state, { userId, platform, verifier, expiresAt: Date.now() + STATE_TTL_MS });

  if (platform === "x") {
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.X_CLIENT_ID!,
      redirect_uri: REDIRECT("x"),
      scope: "tweet.read tweet.write users.read offline.access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `https://twitter.com/i/oauth2/authorize?${params}`;
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
  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
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
  app.get<{ Params: { platform: string }; Querystring: { u?: string } }>(
    "/oauth/:platform/start",
    async (req, reply) => {
      const platform = req.params.platform as Platform;
      if (platform !== "x" && platform !== "linkedin") return reply.code(404).send("unknown platform");
      const userId = req.query.u;
      if (!userId) return reply.code(400).send("missing user");
      const url = buildAuthUrl(userId, platform);
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

      try {
        if (platform === "x") {
          const tok = await exchangeX(code, pend.verifier);
          await storeToken(pend.userId, "x", tok);
        } else {
          const tok = await exchangeLinkedIn(code);
          await storeToken(pend.userId, "linkedin", tok);
        }
      } catch (err) {
        req.log.error({ err }, "oauth token exchange failed");
        return reply.type("text/html").send(DONE_HTML("Something went wrong connecting your account. Try again from the bot."));
      }
      return reply.type("text/html").send(DONE_HTML(`Your ${platform === "x" ? "X" : "LinkedIn"} account is connected for posting. ✅`));
    },
  );
}
