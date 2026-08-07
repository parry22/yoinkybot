import { NextResponse } from "next/server";
import { CapReachedError, connectLinkedInProfileFromWeb } from "@yoink/backend/web";
import { getSessionUser } from "@/lib/session";
import { requirePaid, upgradeRequiredResponse, capReachedResponse } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const entitlements = await requirePaid(user);
  if (!entitlements) return upgradeRequiredResponse();
  const body = (await req.json().catch(() => ({}))) as { profileUrl?: unknown };
  if (typeof body.profileUrl !== "string") return NextResponse.json({ error: "profile URL required" }, { status: 400 });
  try {
    await connectLinkedInProfileFromWeb(user.id, body.profileUrl);
    return NextResponse.json({ ok: true });
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
    return NextResponse.json({ error: err instanceof Error ? err.message : "could not connect LinkedIn" }, { status: 400 });
  }
}
