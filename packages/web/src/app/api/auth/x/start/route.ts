import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const X_OAUTH_COOKIE = "x_oauth";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Kick off X OAuth (PKCE) from the web. This is the "connect X" flow (identity
 * is Clerk's job now): the signed-in user authorizes X, and the callback stores
 * the posting token and starts the history read. The PKCE verifier rides an
 * httpOnly cookie so this works on serverless.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const clientId = process.env.X_CLIENT_ID;
  if (!clientId) return NextResponse.redirect(new URL("/app?connect_error=1", origin));

  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirectUri = `${origin}/api/auth/x/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "tweet.read tweet.write users.read offline.access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const res = NextResponse.redirect(`https://x.com/i/oauth2/authorize?${params.toString()}`);
  res.cookies.set(X_OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
