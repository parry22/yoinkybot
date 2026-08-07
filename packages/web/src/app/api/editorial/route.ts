import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid, upgradeRequiredResponse } from "@/lib/entitlements";
import { jsonError } from "@/lib/api-error";
import { consumeRateLimit, generateEditorialReview, rateLimitMessage, resolveWorkspaceContext } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await requirePaid(user);
  if (!entitlements) return upgradeRequiredResponse();
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) return NextResponse.json({ error: "No active workspace." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const limit = await consumeRateLimit(user.id, "company_editorial");
    if (!limit.ok) {
      return NextResponse.json(
        { error: rateLimitMessage(limit.retryAfterSec) },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
      );
    }
    if (typeof body.periodStart !== "string" || typeof body.periodEnd !== "string") {
      throw new Error("Review dates are required.");
    }
    return NextResponse.json(
      { review: await generateEditorialReview(user.id, workspace.id, body.periodStart, body.periodEnd) },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "Could not generate review.");
  }
}
