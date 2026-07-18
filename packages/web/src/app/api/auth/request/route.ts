import { NextResponse } from "next/server";
import { createLoginToken } from "@yoink/backend/web";
import { sendMagicLink } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const token = await createLoginToken(email);
  const origin = new URL(req.url).origin;
  const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const sent = await sendMagicLink(email, link);

  return NextResponse.json({
    ok: true,
    sent,
    // In dev (no mailer) surface the link so sign-in works without email setup.
    devLink: process.env.NODE_ENV !== "production" ? link : undefined,
  });
}
