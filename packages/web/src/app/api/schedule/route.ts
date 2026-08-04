import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { createWebScheduledPost, ModerationError } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user)))
    return NextResponse.json({ error: "upgrade_required" }, { status: 402 });

  const body = (await req.json().catch(() => ({}))) as {
    content?: unknown;
    scheduledFor?: unknown;
    mediaIds?: unknown;
    platform?: unknown;
  };
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const scheduledFor = typeof body.scheduledFor === "string" ? body.scheduledFor : "";
  const platform = body.platform === "linkedin" ? "linkedin" : body.platform === "x" ? "x" : null;
  const mediaIds = Array.isArray(body.mediaIds)
    ? body.mediaIds.filter((m): m is string => typeof m === "string").slice(0, 4)
    : [];
  if (!scheduledFor) return NextResponse.json({ error: "time required" }, { status: 400 });
  if (!platform) return NextResponse.json({ error: "platform must be X or LinkedIn" }, { status: 400 });
  // An image on its own is a valid post, so text is only required when nothing
  // is attached.
  if (!content && mediaIds.length === 0) {
    return NextResponse.json({ error: "write something or attach media" }, { status: 400 });
  }

  try {
    const res = await createWebScheduledPost(user.id, platform, content, scheduledFor, mediaIds);
    if (!res.ok) {
      // The monthly cap → 429 + Scale CTA; every other rejection (links, bad
      // time) stays a plain 400.
      if (res.capReached) {
        return NextResponse.json(
          { error: "cap_reached", reason: res.reason, upgradeTo: "scale" },
          { status: 429 },
        );
      }
      return NextResponse.json({ error: res.reason ?? "could not schedule" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, id: res.id });
  } catch (err) {
    if (err instanceof ModerationError) return NextResponse.json({ error: err.reason }, { status: 400 });
    console.error("web schedule failed", err);
    return NextResponse.json({ error: "could not schedule" }, { status: 500 });
  }
}
