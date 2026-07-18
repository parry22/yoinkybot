import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { findOrCreateUserByEmail, createSession } from "@yoink/backend/web";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GOOGLE_STATE_COOKIE = "g_state";

function fail(origin: string, reason: string) {
  return NextResponse.redirect(new URL(`/login?error=${reason}`, origin));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const savedState = jar.get(GOOGLE_STATE_COOKIE)?.value;
  if (!code || !state || !savedState || state !== savedState) {
    return fail(origin, "google_state");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(origin, "google_unconfigured");

  const redirectUri = `${origin}/api/auth/google/callback`;

  try {
    // Exchange the authorization code for tokens.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      console.error("google token exchange failed", tokenRes.status, await tokenRes.text().catch(() => ""));
      return fail(origin, "google_failed");
    }
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return fail(origin, "google_failed");

    // Fetch the verified profile (email).
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!infoRes.ok) return fail(origin, "google_failed");
    const profile = (await infoRes.json()) as { email?: string; email_verified?: boolean };
    if (!profile.email || profile.email_verified === false) return fail(origin, "google_email");

    const user = await findOrCreateUserByEmail(profile.email);
    const sessionToken = await createSession(user.id);

    const res = NextResponse.redirect(new URL("/app", origin));
    res.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    res.cookies.set(GOOGLE_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    console.error("google callback failed", err);
    return fail(origin, "google_failed");
  }
}
