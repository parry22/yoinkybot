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

  const fail = (reason: string) => {
    console.error("x oauth callback:", reason);
    return NextResponse.redirect(new URL("/app?connect_error=1", origin));
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
  if (!clientId || !clientSecret) return fail("x not configured");
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
    if (!tokRes.ok) return fail(`token exchange ${tokRes.status}`);
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
