import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createOAuthState } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kick off LinkedIn OAuth from the web. Requires a Clerk session (same gate as
 * X connect start) — identity is Clerk's job; this only mints posting consent.
 * CSRF state is stored in Postgres (`oauth_states`) and consumed once on callback.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/sign-in", origin));

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) return NextResponse.redirect(new URL("/app/integrations?connect_error=config", origin));
  const state = await createOAuthState({
    userId: user.id,
    platform: "web_linkedin",
  });
  const redirectUri = `${origin}/api/auth/linkedin/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "w_member_social openid profile",
    state,
  });
  return NextResponse.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
}
