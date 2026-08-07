import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  approveContentAsset,
  approveContentBrief,
  draftFromBrief,
  generateBriefOptions,
  resolveWorkspaceContext,
  scheduleContentAsset,
  atomizeContentAsset,
  CONTENT_ASSET_TYPES,
  consumeRateLimit,
  rateLimitMessage,
  updateContentBrief,
  reviewContentAsset,
  rejectContentAsset,
  reviseContentAsset,
  ensureStudioReady,
  studioGenerate,
} from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) return NextResponse.json({ error: "No active workspace." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (body.action) {
      case "ensure_ready":
        return NextResponse.json(await ensureStudioReady(user.id, workspace.id));
      case "studio_generate": {
        const limit = await consumeRateLimit(user.id, "company_briefs");
        if (!limit.ok) {
          return NextResponse.json(
            { error: rateLimitMessage(limit.retryAfterSec) },
            { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
          );
        }
        const format =
          typeof body.format === "string" && CONTENT_ASSET_TYPES.includes(body.format as (typeof CONTENT_ASSET_TYPES)[number])
            ? (body.format as (typeof CONTENT_ASSET_TYPES)[number])
            : "linkedin_post";
        const knowledgeObjectIds = Array.isArray(body.knowledgeObjectIds)
          ? body.knowledgeObjectIds.filter((value): value is string => typeof value === "string")
          : [];
        const result = await studioGenerate(user.id, workspace.id, {
          format,
          channel: body.channel === "x" || body.channel === "linkedin" ? body.channel : undefined,
          knowledgeObjectIds,
          userPrompt: typeof body.userPrompt === "string" ? body.userPrompt : undefined,
          tone: typeof body.tone === "string" ? body.tone : undefined,
        });
        return NextResponse.json(result, { status: 201 });
      }
      case "generate_brief": {
        const limit = await consumeRateLimit(user.id, "company_briefs");
        if (!limit.ok) {
          return NextResponse.json(
            { error: rateLimitMessage(limit.retryAfterSec) },
            { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
          );
        }
        const channel = body.channel === "x" || body.channel === "linkedin" || body.channel === "both" ? body.channel : "both";
        const knowledgeObjectIds = Array.isArray(body.knowledgeObjectIds)
          ? body.knowledgeObjectIds.filter((value): value is string => typeof value === "string")
          : undefined;
        return NextResponse.json(
          {
            briefs: await generateBriefOptions(user.id, workspace.id, {
              channel,
              count: typeof body.count === "number" ? body.count : 3,
              knowledgeObjectIds,
              userPrompt: typeof body.userPrompt === "string" ? body.userPrompt : undefined,
              preferredFormat: typeof body.preferredFormat === "string" ? body.preferredFormat : undefined,
            }),
          },
          { status: 201 },
        );
      }
      case "update_brief":
        if (typeof body.briefId !== "string") throw new Error("Brief is required.");
        return NextResponse.json({
          brief: await updateContentBrief(user.id, workspace.id, body.briefId, {
            objective: typeof body.objective === "string" ? body.objective : "",
            desiredBeliefShift: typeof body.desiredBeliefShift === "string" ? body.desiredBeliefShift : "",
            buyingStage: typeof body.buyingStage === "string" ? body.buyingStage : "problem_aware",
            format: typeof body.format === "string" ? body.format : "text_post",
            ctaText: typeof body.ctaText === "string" ? body.ctaText : null,
          }),
        });
      case "approve_brief":
        if (typeof body.briefId !== "string") throw new Error("Brief is required.");
        return NextResponse.json({ brief: await approveContentBrief(user.id, workspace.id, body.briefId) });
      case "draft":
        if (typeof body.briefId !== "string") throw new Error("Brief is required.");
        return NextResponse.json({ asset: await draftFromBrief(user.id, workspace.id, body.briefId) }, { status: 201 });
      case "approve_asset":
        if (typeof body.assetId !== "string") throw new Error("Asset is required.");
        return NextResponse.json({ asset: await approveContentAsset(user.id, workspace.id, body.assetId) });
      case "reject_asset":
        if (typeof body.assetId !== "string") throw new Error("Asset is required.");
        return NextResponse.json({
          asset: await rejectContentAsset(user.id, workspace.id, body.assetId, typeof body.note === "string" ? body.note : undefined),
        });
      case "review_asset":
        if (typeof body.assetId !== "string" || (body.decision !== "changes_requested" && body.decision !== "comment")) {
          throw new Error("Asset and review decision are required.");
        }
        return NextResponse.json({
          asset: await reviewContentAsset(user.id, workspace.id, body.assetId, body.decision, typeof body.note === "string" ? body.note : ""),
        });
      case "revise_asset":
        if (typeof body.assetId !== "string" || typeof body.content !== "string") throw new Error("Asset and content are required.");
        return NextResponse.json({
          asset: await reviseContentAsset(
            user.id,
            workspace.id,
            body.assetId,
            body.content,
            typeof body.changeSummary === "string" ? body.changeSummary : undefined,
          ),
        });
      case "schedule": {
        if (typeof body.assetId !== "string" || typeof body.scheduledFor !== "string") {
          throw new Error("Asset and schedule time are required.");
        }
        const platforms = Array.isArray(body.platforms)
          ? body.platforms.filter((value): value is "x" | "linkedin" => value === "x" || value === "linkedin")
          : undefined;
        return NextResponse.json({
          publications: await scheduleContentAsset(user.id, workspace.id, body.assetId, body.scheduledFor, platforms),
        });
      }
      case "atomize": {
        if (typeof body.assetId !== "string" || !Array.isArray(body.targetFormats)) throw new Error("Asset and target formats are required.");
        const targets = body.targetFormats.filter((value): value is (typeof CONTENT_ASSET_TYPES)[number] =>
          typeof value === "string" && CONTENT_ASSET_TYPES.includes(value as (typeof CONTENT_ASSET_TYPES)[number]));
        return NextResponse.json({ assets: await atomizeContentAsset(user.id, workspace.id, body.assetId, targets) }, { status: 201 });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    console.error("brief workflow failed", error);
    const message = error instanceof Error ? error.message : "Could not complete workflow.";
    const href =
      message.includes("narrative") ? "/app/narrative"
      : message.includes("insight") || message.includes("Knowledge") || message.includes("proof") || message.includes("claim")
        ? "/app/knowledge"
        : message.includes("expert") ? "/app/settings"
        : undefined;
    return NextResponse.json({ error: message, href }, { status: 400 });
  }
}
