import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "linkedin_oauth";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) return NextResponse.redirect(new URL("/app/settings?connect_error=config", origin));
  const state = randomBytes(24).toString("base64url");
  const redirectUri = `${origin}/api/auth/linkedin/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "w_member_social openid profile",
    state,
  });
  const response = NextResponse.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
  response.cookies.set(COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return response;
}
