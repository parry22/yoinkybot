import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requirePaid, upgradeRequiredResponse } from "@/lib/entitlements";
import { jsonError } from "@/lib/api-error";
import {
  generateNarrativeProposal,
  resolveWorkspaceContext,
  updateNarrativeDraft,
  consumeRateLimit,
  rateLimitMessage,
  createWorkspaceAudience,
  createBuyerJourneyQuestion,
  reviewRegisteredClaim,
} from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req:Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await requirePaid(user);
  if (!entitlements) return upgradeRequiredResponse();
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) return NextResponse.json({ error: "No active workspace." }, { status: 400 });
  try {
    const body=(await req.json().catch(()=>({}))) as Record<string,unknown>;
    if(body.action==="create_audience")return NextResponse.json({audience:await createWorkspaceAudience(user.id,workspace.id,{name:typeof body.name==="string"?body.name:"",roleType:typeof body.roleType==="string"?body.roleType:"other",description:typeof body.description==="string"?body.description:"",needs:Array.isArray(body.needs)?body.needs.filter((item):item is string=>typeof item==="string"):[],objections:Array.isArray(body.objections)?body.objections.filter((item):item is string=>typeof item==="string"):[],successDefinition:typeof body.successDefinition==="string"?body.successDefinition:""})},{status:201});
    if(body.action==="create_journey_question")return NextResponse.json({question:await createBuyerJourneyQuestion(user.id,workspace.id,{audienceId:typeof body.audienceId==="string"&&body.audienceId?body.audienceId:null,stage:typeof body.stage==="string"?body.stage:"problem_aware",question:typeof body.question==="string"?body.question:"",priority:typeof body.priority==="number"?body.priority:50})},{status:201});
    const limit=await consumeRateLimit(user.id,"company_narrative");if(!limit.ok)return NextResponse.json({error:rateLimitMessage(limit.retryAfterSec)},{status:429,headers:{"retry-after":String(limit.retryAfterSec)}});
    const narrative = await generateNarrativeProposal(user.id, workspace.id);
    return NextResponse.json({ narrative }, { status: 201 });
  } catch (error) {
    return jsonError(error, "Could not build narrative.");
  }
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await requirePaid(user);
  if (!entitlements) return upgradeRequiredResponse();
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) return NextResponse.json({ error: "No active workspace." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if(body.action==="review_claim"){
      if(typeof body.claimId!=="string")throw new Error("Claim is required.");
      const decision=body.decision==="approved"||body.decision==="rejected"||body.decision==="prohibited"?body.decision:null;
      const riskLevel=body.riskLevel==="low"||body.riskLevel==="medium"||body.riskLevel==="high"||body.riskLevel==="regulated"?body.riskLevel:null;
      if(!decision||!riskLevel)throw new Error("Claim decision and risk are required.");
      const claim=await reviewRegisteredClaim(user.id,workspace.id,body.claimId,{decision,riskLevel,evidenceRequirements:typeof body.evidenceRequirements==="string"?body.evidenceRequirements:null,evidenceObjectIds:Array.isArray(body.evidenceObjectIds)?body.evidenceObjectIds.filter((item):item is string=>typeof item==="string"):[],allowedContexts:Array.isArray(body.allowedContexts)?body.allowedContexts.filter((item):item is string=>typeof item==="string"):[],prohibitedContexts:Array.isArray(body.prohibitedContexts)?body.prohibitedContexts.filter((item):item is string=>typeof item==="string"):[],expiresAt:typeof body.expiresAt==="string"&&body.expiresAt?body.expiresAt:null});
      return NextResponse.json({claim});
    }
    if (typeof body.narrativeId !== "string") return NextResponse.json({ error: "Narrative is required." }, { status: 400 });
    const narrative = await updateNarrativeDraft(user.id, workspace.id, body.narrativeId, {
      categoryThesis: typeof body.categoryThesis === "string" ? body.categoryThesis : "",
      problemNarrative: typeof body.problemNarrative === "string" ? body.problemNarrative : "",
      pointOfView: typeof body.pointOfView === "string" ? body.pointOfView : "",
      uniqueMechanism: typeof body.uniqueMechanism === "string" ? body.uniqueMechanism : "",
      primaryPromise: typeof body.primaryPromise === "string" ? body.primaryPromise : "",
    }, body.activate === true);
    return NextResponse.json({ narrative });
  } catch (error) {
    return jsonError(error, "Could not save narrative.");
  }
}
