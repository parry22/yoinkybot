import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid, upgradeRequiredResponse } from "@/lib/entitlements";
import { jsonError } from "@/lib/api-error";
import {
  createConversionAction,
  buildTrackedCtaUrl,
  createCampaign,
  recommendCampaignDistributionPlan,
  recommendDistributionPlan,
  recordManualInfluence,
  resolveWorkspaceContext,
  updateDistributionStep,
  consumeRateLimit,
  rateLimitMessage,
} from "@yoink/backend/web";

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
    if (body.action === "recommend") {
      const limit = await consumeRateLimit(user.id, "distribution_recommend");
      if (!limit.ok) {
        return NextResponse.json(
          { error: rateLimitMessage(limit.retryAfterSec) },
          { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
        );
      }
      if (typeof body.assetId !== "string") throw new Error("Asset is required.");
      return NextResponse.json(
        { steps: await recommendDistributionPlan(user.id, workspace.id, body.assetId) },
        { status: 201 },
      );
    }
    if (body.action === "create_campaign") {
      if (typeof body.name !== "string" || typeof body.objective !== "string") {
        throw new Error("Campaign name and objective are required.");
      }
      return NextResponse.json(
        {
          campaign: await createCampaign(user.id, workspace.id, {
            name: body.name,
            objective: body.objective,
            startAt: typeof body.startAt === "string" ? body.startAt : null,
            endAt: typeof body.endAt === "string" ? body.endAt : null,
          }),
        },
        { status: 201 },
      );
    }
    if (body.action === "recommend_campaign") {
      const limit = await consumeRateLimit(user.id, "distribution_recommend");
      if (!limit.ok) {
        return NextResponse.json(
          { error: rateLimitMessage(limit.retryAfterSec) },
          { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
        );
      }
      if (typeof body.campaignId !== "string") throw new Error("Campaign is required.");
      return NextResponse.json(
        { steps: await recommendCampaignDistributionPlan(user.id, workspace.id, body.campaignId) },
        { status: 201 },
      );
    }
    if (body.action === "update_step") {
      if (typeof body.stepId !== "string" || typeof body.status !== "string") {
        throw new Error("Step and status are required.");
      }
      await updateDistributionStep(
        user.id,
        workspace.id,
        body.stepId,
        body.status as "recommended" | "planned" | "scheduled" | "completed" | "skipped",
      );
      return NextResponse.json({ ok: true });
    }
    if (body.action === "create_cta") {
      if (
        typeof body.name !== "string" ||
        typeof body.actionType !== "string" ||
        typeof body.destination !== "string" ||
        typeof body.commitmentLevel !== "string"
      ) {
        throw new Error("Complete every CTA field.");
      }
      return NextResponse.json(
        {
          conversionAction: await createConversionAction(user.id, workspace.id, {
            name: body.name,
            actionType: body.actionType,
            destination: body.destination,
            commitmentLevel: body.commitmentLevel,
          }),
        },
        { status: 201 },
      );
    }
    if (body.action === "build_tracked_url") {
      if (typeof body.actionId !== "string") throw new Error("CTA is required.");
      return NextResponse.json({
        trackedUrl: await buildTrackedCtaUrl(user.id, workspace.id, body.actionId, {
          assetId: typeof body.assetId === "string" && body.assetId ? body.assetId : null,
          publicationId:
            typeof body.publicationId === "string" && body.publicationId ? body.publicationId : null,
          campaignId: typeof body.campaignId === "string" && body.campaignId ? body.campaignId : null,
        }),
      });
    }
    if (body.action === "manual_influence") {
      if (typeof body.actionId !== "string" || !(["lead", "opportunity", "revenue"] as unknown[]).includes(body.eventType)) {
        throw new Error("CTA and outcome type are required.");
      }
      await recordManualInfluence(user.id, workspace.id, {
        actionId: body.actionId,
        assetId: typeof body.assetId === "string" ? body.assetId : null,
        eventType: body.eventType as "lead" | "opportunity" | "revenue",
        externalOpportunityId: typeof body.externalOpportunityId === "string" ? body.externalOpportunityId : null,
        value: typeof body.value === "number" ? body.value : null,
        currency: typeof body.currency === "string" ? body.currency : null,
        note: typeof body.note === "string" ? body.note : null,
      });
      return NextResponse.json({ ok: true }, { status: 201 });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return jsonError(error, "Could not complete distribution workflow.");
  }
}
