import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { createOAuthState, xDeveloperCredentialsForUser } from "@yoink/backend/web";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Kick off X OAuth (PKCE) from the web. Requires a Clerk session; CSRF state and
 * the PKCE verifier are stored in Postgres (`oauth_states`) and consumed once on callback.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));
  const own = await xDeveloperCredentialsForUser(user.id);
  const clientId = own?.clientId ?? process.env.X_CLIENT_ID;
  if (!clientId) {
    console.error("x oauth start: X_CLIENT_ID is not set");
    return NextResponse.redirect(new URL("/app/integrations?connect_error=config", origin));
  }

  const verifier = b64url(randomBytes(32));
  const state = await createOAuthState({
    userId: user.id,
    platform: "web_x",
    verifier,
  });
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirectUri = `${origin}/api/auth/x/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "tweet.read tweet.write users.read media.write offline.access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return NextResponse.redirect(`https://x.com/i/oauth2/authorize?${params.toString()}`);
}
