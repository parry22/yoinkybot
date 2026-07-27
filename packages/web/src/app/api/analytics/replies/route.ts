import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { getReplyAnalytics } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Paid-only: every call is a live twitterapi.io fetch of the user's replies,
  // billed per request. This was the last analytics route spending that budget
  // for free/expired accounts. The body keeps the ReplyAnalytics shape as well as
  // the 402 marker so the client's `available: false` branch degrades cleanly.
  if (!(await requirePaid(user)))
    return NextResponse.json(
      {
        error: "upgrade_required",
        available: false,
        reason: "upgrade_required",
        count: 0,
        medianImpressions: null,
        medianEngagementRate: null,
        sample: [],
      },
      { status: 402 },
    );
  // Burst guard — each call is a billed twitterapi.io timeline read.
  const limited = await rateLimited(user.id, "analytics_replies");
  if (limited) return limited;
  try {
    const data = await getReplyAnalytics(user.id);
    return NextResponse.json(data);
  } catch (err) {
    console.error("reply analytics failed", err);
    return NextResponse.json({ error: "reply analytics failed" }, { status: 500 });
  }
}
