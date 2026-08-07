import { NextResponse } from "next/server";
import {
  consumeRateLimit,
  conversionWebhookOwnerUserId,
  rateLimitMessage,
  recordConversionEvent,
} from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (
      typeof body.actionId !== "string" ||
      typeof body.token !== "string" ||
      typeof body.eventType !== "string" ||
      typeof body.deduplicationKey !== "string" ||
      typeof body.occurredAt !== "string"
    ) {
      throw new Error("Missing conversion event fields.");
    }
    if (!UUID_RE.test(body.actionId)) throw new Error("Invalid conversion action.");

    const ownerId = await conversionWebhookOwnerUserId(body.actionId);
    if (!ownerId) throw new Error("Invalid conversion action.");

    // Fail-closed: a Neon blip must not open an unbounded write path.
    const limit = await consumeRateLimit(ownerId, "conversion_webhook", { failClosed: true });
    if (!limit.ok) {
      return NextResponse.json(
        { error: rateLimitMessage(limit.retryAfterSec) },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
      );
    }

    const result = await recordConversionEvent({
      actionId: body.actionId,
      token: body.token,
      eventType: body.eventType,
      deduplicationKey: body.deduplicationKey,
      occurredAt: body.occurredAt,
      assetId: typeof body.assetId === "string" ? body.assetId : null,
      publicationId: typeof body.publicationId === "string" ? body.publicationId : null,
      campaignId: typeof body.campaignId === "string" ? body.campaignId : null,
      value: typeof body.value === "number" ? body.value : null,
      currency: typeof body.currency === "string" ? body.currency : null,
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid conversion event.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
