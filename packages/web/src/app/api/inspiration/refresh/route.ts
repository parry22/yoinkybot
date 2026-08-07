import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid, upgradeRequiredResponse, capReachedResponse } from "@/lib/entitlements";
import { rateLimited } from "@/lib/rate-limit";
import { CapReachedError, refreshInspirationForWeb } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A refresh runs the trend matcher + a bounded viral-pool search.
export const maxDuration = 300;

/**
 * On-demand Inspiration fill: runs the same seed pipeline the post-diagnosis
 * job uses, stale-guarded server-side (no-op if the feed was refreshed in the
 * last few hours). The client calls this when the page comes up empty, then
 * re-renders the server lists.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const entitlements = await requirePaid(user);
  if (!entitlements) return upgradeRequiredResponse();
  // Burst guard: the paywall says "may spend", the monthly cap says "how much";
  // this says "how fast". See backend lib/rate-limit.ts.
  const limited = await rateLimited(user.id, "inspiration_refresh");
  if (limited) return limited;
  try {
    const res = await refreshInspirationForWeb(user.id);
    return NextResponse.json(res);
  } catch (err) {
    if (
      err instanceof CapReachedError ||
      (err && typeof err === "object" && (err as { code?: unknown }).code === "cap_reached")
    ) {
      return capReachedResponse(
        (err as { cap?: string }).cap ?? "plan",
        err instanceof Error ? err.message : "Cap reached",
      );
    }
    console.error("inspiration refresh failed", err);
    return NextResponse.json({ error: "refresh failed" }, { status: 500 });
  }
}
