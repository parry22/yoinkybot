import { NextResponse } from "next/server";
import { consumeLoginToken, createSession } from "@yoink/backend/web";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const user = token ? await consumeLoginToken(token) : undefined;

  if (!user) {
    return NextResponse.redirect(new URL("/login?error=expired", url.origin));
  }

  const sessionToken = await createSession(user.id);
  const res = NextResponse.redirect(new URL("/app", url.origin));
  res.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
