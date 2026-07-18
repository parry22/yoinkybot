import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Lightweight gate: bounce unauthenticated visitors off /app before render.
// Presence only — the session token is validated in server components.
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("yoink_session");
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/app/:path*"] };
