import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { finalizeLinkedInConnect } from "@yoink/backend/web";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const COOKIE = "linkedin_oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const savedState = (await cookies()).get(COOKIE)?.value;
  if (!code || !state || !savedState || state !== savedState) {
    return NextResponse.redirect(new URL("/app/settings?connect_error=retry", origin));
  }
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return NextResponse.redirect(new URL("/app/settings?connect_error=config", origin));

  try {
    const redirectUri = `${origin}/api/auth/linkedin/callback`;
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!tokenRes.ok || !token.access_token) throw new Error(`token exchange ${tokenRes.status}`);
    const meRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const me = (await meRes.json().catch(() => ({}))) as { sub?: string; name?: string };
    if (!meRes.ok || !me.sub) throw new Error(`userinfo ${meRes.status}`);
    await finalizeLinkedInConnect(user.id, {
      accessToken: token.access_token,
      expiresIn: token.expires_in,
      authorUrn: `urn:li:person:${me.sub}`,
      displayName: me.name,
    });
    const response = NextResponse.redirect(new URL("/app/settings?connected=linkedin", origin));
    response.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  } catch (err) {
    console.error("linkedin oauth callback failed", err);
    return NextResponse.redirect(new URL("/app/settings?connect_error=retry", origin));
  }
}
