import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { finalizeXConnect } from "@yoink/backend/web";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const X_OAUTH_COOKIE = "x_oauth";

/**
 * X OAuth callback — connect only. Identity is Clerk's now, so this requires an
 * existing Clerk session and attaches the X posting token to that account
 * (finalizeXConnect also kicks the history read). An unauthenticated hit is
 * bounced to sign-in.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const existing = await getSessionUser();
  if (!existing) return NextResponse.redirect(new URL("/sign-in", origin));

  /**
   * `kind` separates "try again" from "an operator has to fix something".
   *
   * Everything used to funnel into connect_error=1, whose copy says "please try
   * again" — advice that is actively wrong for a 401. X returns 401
   * unauthorized_client when the client credentials it was handed are not the
   * ones it issued, and no amount of retrying changes that. Telling the user to
   * retry in that case wastes their time and hides a config bug from us.
   *
   * The distinction is safe to expose: it says which side the fault is on, and
   * nothing about the credentials themselves.
   */
  const fail = (reason: string, kind: "retry" | "config" = "retry") => {
    console.error("x oauth callback:", reason);
    return NextResponse.redirect(new URL(`/app?connect_error=${kind}`, origin));
  };

  const jar = await cookies();
  const raw = jar.get(X_OAUTH_COOKIE)?.value;
  let saved: { state?: string; verifier?: string } | null = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  if (!code || !state || !saved?.verifier || saved.state !== state) return fail("bad state");

  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail("x not configured", "config");
  const redirectUri = `${origin}/api/auth/x/callback`;

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: saved.verifier,
        client_id: clientId,
      }),
    });
    if (!tokRes.ok) {
      // Log X's own error body, not just the status. "401" alone sent us hunting
      // through PKCE, cookies and redirect URIs; X actually says
      // `unauthorized_client / Missing valid authorization header`, which names
      // the client credentials directly and would have ended that hunt at once.
      const body = await tokRes.text().catch(() => "");
      // 401 = X does not recognise the client credentials we sent. Since X only
      // issues a code for a client_id it knows, a 401 here means the SECRET is
      // stale or mismatched — an operator fix, never a user retry.
      // 400 = a genuinely spent/expired code, which retrying does resolve.
      return fail(
        `token exchange ${tokRes.status}: ${body.slice(0, 300)}`,
        tokRes.status === 401 || tokRes.status === 403 ? "config" : "retry",
      );
    }
    const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!tok.access_token) return fail("no access token");

    const meRes = await fetch("https://api.x.com/2/users/me", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!meRes.ok) return fail(`users/me ${meRes.status}`);
    const me = (await meRes.json()) as { data?: { id?: string; username?: string } };
    const username = me.data?.username;
    if (!me.data?.id) return fail("no x id");

    await finalizeXConnect(existing.id, {
      handle: username ? `@${username}` : "connected",
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresIn: tok.expires_in,
      scope: tok.scope,
    });

    // Land back in the app; the connect popup shows the "reading" animation.
    const res = NextResponse.redirect(new URL("/app?connected=x", origin));
    res.cookies.set(X_OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    return fail(String(err));
  }
}
