import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireWorkspaceRole } from "../workspaces/service.js";
import { open, seal, type Sealed } from "../lib/crypto.js";
import type { CampaignView, ConversionActionView, ConversionEventView, DistributionStepType, DistributionStepView } from "./types.js";

const EVENT_TYPES = ["click","signup","download","reply","demo","lead","opportunity","revenue"] as const;
type EventType = (typeof EVENT_TYPES)[number];

export function isSupportedConversionEvent(value:string):value is EventType{return EVENT_TYPES.includes(value as EventType);}
export function assertFreshConversionTimestamp(value:string,now=Date.now()):Date{const occurred=new Date(value);if(!Number.isFinite(occurred.getTime())||Math.abs(now-occurred.getTime())>86_400_000)throw new Error("Conversion timestamp is outside the accepted window.");return occurred;}
export function recommendedDistributionStepTypes(assetType:string,connectedPlatforms:Iterable<string>):DistributionStepType[]{const connected=new Set(connectedPlatforms);const steps:DistributionStepType[]=["primary_publish","founder_amplification","sales_reuse","resurface"];const secondary=assetType==="x_post"?"linkedin":assetType==="linkedin_post"?"x":null;if(secondary&&connected.has(secondary))steps.splice(1,0,"secondary_channel");return steps;}

const tokenHash = (token:string) => createHash("sha256").update(token).digest("hex");
const safeTokenEqual = (token:string, expected:string) => {
  const actual=Buffer.from(tokenHash(token),"hex"); const stored=Buffer.from(expected,"hex");
  return actual.length===stored.length && timingSafeEqual(actual,stored);
};

export async function listDistributionSteps(userId:string,workspaceId:string):Promise<DistributionStepView[]> {
  await requireWorkspaceRole(userId,workspaceId,"viewer");
  const rows=await query<{id:string;content_asset_id:string|null;title:string|null;asset_type:string|null;campaign_id:string|null;campaign_name:string|null;step_type:DistributionStepType;status:DistributionStepView["status"];instructions:string;scheduled_at:string|null;completed_at:string|null}>(
    `SELECT ds.id,ds.content_asset_id,ca.title,ca.asset_type,ds.campaign_id,cc.name campaign_name,ds.step_type,ds.status,ds.instructions,ds.scheduled_at::text,ds.completed_at::text
       FROM distribution_steps ds LEFT JOIN content_assets ca ON ca.id=ds.content_asset_id AND ca.workspace_id=ds.workspace_id LEFT JOIN content_campaigns cc ON cc.id=ds.campaign_id AND cc.workspace_id=ds.workspace_id
      WHERE ds.workspace_id=$1 ORDER BY ca.created_at DESC,ds.created_at`,[workspaceId]);
  return rows.map(row=>({id:row.id,assetId:row.content_asset_id,assetTitle:row.title,assetType:row.asset_type,campaignId:row.campaign_id,campaignName:row.campaign_name,stepType:row.step_type,status:row.status,instructions:row.instructions,scheduledAt:row.scheduled_at,completedAt:row.completed_at}));
}

export async function listCampaigns(userId:string,workspaceId:string):Promise<CampaignView[]>{await requireWorkspaceRole(userId,workspaceId,"viewer");const rows=await query<{id:string;name:string;objective:string;status:CampaignView["status"];start_at:string;end_at:string|null}>(`SELECT id,name,objective,status,start_at::text,end_at::text FROM content_campaigns WHERE workspace_id=$1 ORDER BY start_at DESC`,[workspaceId]);return rows.map(row=>({id:row.id,name:row.name,objective:row.objective,status:row.status,startAt:row.start_at,endAt:row.end_at}));}
export async function createCampaign(userId:string,workspaceId:string,input:{name:string;objective:string;startAt?:string|null;endAt?:string|null}):Promise<CampaignView>{await requireWorkspaceRole(userId,workspaceId,"strategist");const name=input.name.trim().slice(0,140),objective=input.objective.trim().slice(0,800);if(name.length<2||objective.length<5)throw new Error("Campaign name and objective are required.");const start=input.startAt?new Date(input.startAt):new Date(),end=input.endAt?new Date(input.endAt):null;if(!Number.isFinite(start.getTime())||(end&&(!Number.isFinite(end.getTime())||end<start)))throw new Error("Campaign dates are invalid.");const row=await queryOne<{id:string}>(`INSERT INTO content_campaigns (workspace_id,name,objective,start_at,end_at,status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,[workspaceId,name,objective,start.toISOString(),end?.toISOString()??null]);if(!row)throw new Error("Could not create campaign.");return (await listCampaigns(userId,workspaceId)).find(item=>item.id===row.id)!;}
export async function recommendCampaignDistributionPlan(userId:string,workspaceId:string,campaignId:string):Promise<DistributionStepView[]>{await requireWorkspaceRole(userId,workspaceId,"contributor");const campaign=await queryOne<{id:string;name:string;status:string}>(`SELECT id,name,status FROM content_campaigns WHERE id=$1 AND workspace_id=$2`,[campaignId,workspaceId]);if(!campaign||campaign.status==="archived")throw new Error("Active campaign not found.");const steps:Array<{type:DistributionStepType;instructions:string}>=[{type:"team_amplification",instructions:"Assign approved, role-relevant assets to selected teammates with optional talking points. Never auto-send."},{type:"partner_seeding",instructions:"Identify partners whose audience benefits from the campaign thesis and prepare permission-aware outreach tasks."},{type:"community_placement",instructions:"Select communities where the idea is genuinely useful, then adapt each contribution to local norms."},{type:"sales_reuse",instructions:"Package the campaign's approved proof and objection-handling assets for live sales conversations."},{type:"resurface",instructions:"Review campaign outcomes at the end of the period and retain only repeatable narrative lessons."}];await withTransaction(async client=>{for(const step of steps)await client.query(`INSERT INTO distribution_steps (workspace_id,campaign_id,step_type,owner_user_id,instructions) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,campaign_id,step_type) DO UPDATE SET instructions=EXCLUDED.instructions,updated_at=now()`,[workspaceId,campaignId,step.type,userId,step.instructions]);});return (await listDistributionSteps(userId,workspaceId)).filter(step=>step.campaignId===campaignId);}

export async function recommendDistributionPlan(userId:string,workspaceId:string,assetId:string):Promise<DistributionStepView[]> {
  await requireWorkspaceRole(userId,workspaceId,"contributor");
  const asset=await queryOne<{asset_type:string;title:string;status:string;linked_user_id:string|null;expert_name:string|null;audience_name:string;campaign_name:string|null;campaign_objective:string|null}>(
    `SELECT ca.asset_type,ca.title,ca.status,e.linked_user_id,e.name expert_name,wa.name audience_name,cc.name campaign_name,cc.objective campaign_objective FROM content_assets ca
      JOIN content_briefs cb ON cb.id=ca.brief_id AND cb.workspace_id=ca.workspace_id
      JOIN workspace_audiences wa ON wa.id=cb.audience_id AND wa.workspace_id=ca.workspace_id
      LEFT JOIN content_campaigns cc ON cc.id=cb.campaign_id AND cc.workspace_id=ca.workspace_id
      LEFT JOIN experts e ON e.id=ca.expert_id AND e.workspace_id=ca.workspace_id
      WHERE ca.id=$1 AND ca.workspace_id=$2`,[assetId,workspaceId]);
  if(!asset)throw new Error("Asset not found.");
  if(!["approved","scheduled","published"].includes(asset.status))throw new Error("Approve the asset before planning distribution.");
  const connected=asset.linked_user_id ? await query<{platform:string}>(`SELECT platform FROM connected_accounts WHERE user_id=$1 AND (post_access_token IS NOT NULL OR post_access_token_enc IS NOT NULL)`,[asset.linked_user_id]) : [];
  const platforms=new Set(connected.map(item=>item.platform));
  const prior=await queryOne<{published:string;conversions:string}>(`SELECT count(DISTINCT sp.id) FILTER(WHERE sp.status='published')::text published,count(DISTINCT ce.id)::text conversions FROM content_assets ca LEFT JOIN scheduled_posts sp ON sp.content_asset_id=ca.id LEFT JOIN conversion_events ce ON ce.content_asset_id=ca.id AND ce.workspace_id=ca.workspace_id WHERE ca.workspace_id=$1 AND ca.asset_type=$2`,[workspaceId,asset.asset_type]);
  const evidence=`Audience: ${asset.audience_name}. Source expert: ${asset.expert_name??"Unassigned"}. Campaign: ${asset.campaign_name??"None"}. Prior ${asset.asset_type.replaceAll("_"," ")} evidence: ${prior?.published??0} published and ${prior?.conversions??0} conversions.`;
  const primary=asset.asset_type==="x_post"?"X":asset.asset_type==="linkedin_post"?"LinkedIn":"the selected primary channel";
  const instructions:Record<DistributionStepType,string>={
    primary_publish:`Publish the approved asset on ${primary} at the selected time. ${evidence}`,
    secondary_channel:`Create and approve a channel-native ${asset.asset_type==="x_post"?"LinkedIn":"X"} derivative before publishing. Do not copy and paste the primary asset.`,
    founder_amplification:`Have ${asset.expert_name??"the source expert"} add one substantive reply that extends the idea for ${asset.audience_name}, not a generic reshare.`,
    team_amplification:"Give selected teammates a factual prompt they may adapt. Never auto-send it.",
    partner_seeding:"Share privately with a relevant partner only when permissions allow.",
    community_placement:"Adapt the idea to the community's norms before sharing.",
    sales_reuse:`Share the approved asset with sales alongside one sentence explaining which ${asset.audience_name} buyer question it answers${asset.campaign_objective?` and how it supports ${asset.campaign_objective}`:""}.`,
    resurface:"Review performance after 30 days and resurface only if the idea remains useful and the opening can be made native to the next moment.",
  };
  const steps:Array<{type:DistributionStepType;instructions:string}>=recommendedDistributionStepTypes(asset.asset_type,platforms).map(type=>({type,instructions:instructions[type]}));
  if(asset.campaign_name&&!steps.some(step=>step.type==="team_amplification"))steps.splice(Math.max(1,steps.length-1),0,{type:"team_amplification",instructions:instructions.team_amplification});
  await withTransaction(async client=>{
    for(const step of steps)await client.query(
      `INSERT INTO distribution_steps (workspace_id,content_asset_id,step_type,owner_user_id,instructions)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,content_asset_id,step_type) DO UPDATE SET instructions=EXCLUDED.instructions,updated_at=now()`,
      [workspaceId,assetId,step.type,userId,step.instructions]);
  });
  return (await listDistributionSteps(userId,workspaceId)).filter(step=>step.assetId===assetId);
}

export async function updateDistributionStep(userId:string,workspaceId:string,stepId:string,status:DistributionStepView["status"]):Promise<void>{
  await requireWorkspaceRole(userId,workspaceId,"contributor");
  if(!["recommended","planned","scheduled","completed","skipped"].includes(status))throw new Error("Invalid distribution status.");
  const row=await queryOne<{id:string}>(`UPDATE distribution_steps SET status=$3,completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id`,[stepId,workspaceId,status]);
  if(!row)throw new Error("Distribution step not found.");
}

function trackedUrl(destination:string,actionId:string,token:string,context:{workspaceId:string;assetId?:string|null;publicationId?:string|null;campaignId?:string|null}):string{
  const url=new URL(destination); url.searchParams.set("yoinky_workspace",context.workspaceId);url.searchParams.set("yoinky_cta",actionId);url.searchParams.set("yoinky_token",token);if(context.assetId)url.searchParams.set("yoinky_asset",context.assetId);if(context.publicationId)url.searchParams.set("yoinky_publication",context.publicationId);if(context.campaignId)url.searchParams.set("yoinky_campaign",context.campaignId); return url.toString();
}

export async function createConversionAction(userId:string,workspaceId:string,input:{name:string;actionType:string;destination:string;commitmentLevel:string}):Promise<ConversionActionView>{
  await requireWorkspaceRole(userId,workspaceId,"editor");
  if(!["follow","reply","subscribe","download","audit","webinar","trial","demo","contact_sales","custom"].includes(input.actionType))throw new Error("Unsupported CTA type.");
  if(!["low","medium","high"].includes(input.commitmentLevel))throw new Error("Unsupported commitment level.");
  const destination=new URL(input.destination); if(!["http:","https:"].includes(destination.protocol))throw new Error("CTA destination must use HTTP or HTTPS.");
  const token=randomBytes(24).toString("base64url");
  const row=await queryOne<{id:string}>(
    `INSERT INTO conversion_actions (workspace_id,name,action_type,destination,commitment_level,tracking_token_hash,tracking_token_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[workspaceId,input.name.trim().slice(0,120),input.actionType,destination.toString(),input.commitmentLevel,tokenHash(token),JSON.stringify(seal(token))]);
  if(!row)throw new Error("Could not create CTA.");
  return {id:row.id,name:input.name.trim(),actionType:input.actionType,destination:destination.toString(),commitmentLevel:input.commitmentLevel as "low"|"medium"|"high",status:"active",trackedUrl:trackedUrl(destination.toString(),row.id,token,{workspaceId})};
}

export async function buildTrackedCtaUrl(userId:string,workspaceId:string,actionId:string,context:{assetId?:string|null;publicationId?:string|null;campaignId?:string|null}={}):Promise<string>{
  await requireWorkspaceRole(userId,workspaceId,"contributor");
  const action=await queryOne<{destination:string;tracking_token_encrypted:string|null}>(`SELECT destination,tracking_token_encrypted FROM conversion_actions WHERE id=$1 AND workspace_id=$2 AND status='active'`,[actionId,workspaceId]);if(!action)throw new Error("Active CTA not found.");
  if(context.assetId&&!await queryOne(`SELECT 1 FROM content_assets WHERE id=$1 AND workspace_id=$2`,[context.assetId,workspaceId]))throw new Error("Asset not found in this workspace.");
  // Same ownership path as recordConversionEvent: publication → content_assets.
  if(context.publicationId&&!await queryOne(`SELECT 1 FROM scheduled_posts sp JOIN content_assets ca ON ca.id=sp.content_asset_id WHERE sp.id=$1 AND ca.workspace_id=$2`,[context.publicationId,workspaceId]))throw new Error("Publication not found in this workspace.");
  if(context.campaignId&&!await queryOne(`SELECT 1 FROM content_campaigns WHERE id=$1 AND workspace_id=$2`,[context.campaignId,workspaceId]))throw new Error("Campaign not found in this workspace.");
  let token:string;if(action.tracking_token_encrypted)token=open(JSON.parse(action.tracking_token_encrypted) as Sealed);else{token=randomBytes(24).toString("base64url");await query(`UPDATE conversion_actions SET tracking_token_hash=$3,tracking_token_encrypted=$4,updated_at=now() WHERE id=$1 AND workspace_id=$2`,[actionId,workspaceId,tokenHash(token),JSON.stringify(seal(token))]);}
  return trackedUrl(action.destination,actionId,token,{workspaceId,...context});
}

export async function listConversionActions(userId:string,workspaceId:string):Promise<ConversionActionView[]> {
  await requireWorkspaceRole(userId,workspaceId,"viewer");
  const rows=await query<{id:string;name:string;action_type:string;destination:string;commitment_level:"low"|"medium"|"high";status:string;tracking_token_encrypted:string|null}>(`SELECT id,name,action_type,destination,commitment_level,status,tracking_token_encrypted FROM conversion_actions WHERE workspace_id=$1 ORDER BY created_at DESC`,[workspaceId]);
  return rows.map(row=>{
    let url: string | undefined;
    if (row.tracking_token_encrypted) {
      try {
        const token = open(JSON.parse(row.tracking_token_encrypted) as Sealed);
        url = trackedUrl(row.destination, row.id, token, { workspaceId });
      } catch {
        url = undefined;
      }
    }
    return {id:row.id,name:row.name,actionType:row.action_type,destination:row.destination,commitmentLevel:row.commitment_level,status:row.status,trackedUrl:url};
  });
}

export async function recordConversionEvent(input:{actionId:string;token:string;assetId?:string|null;publicationId?:string|null;campaignId?:string|null;eventType:string;deduplicationKey:string;occurredAt:string;value?:number|null;currency?:string|null;metadata?:Record<string,unknown>}):Promise<{id:string;duplicate:boolean}>{
  if(!isSupportedConversionEvent(input.eventType))throw new Error("Unsupported conversion event type.");
  const action=await queryOne<{workspace_id:string;tracking_token_hash:string;status:string}>(`SELECT workspace_id,tracking_token_hash,status FROM conversion_actions WHERE id=$1`,[input.actionId]);
  if(!action||action.status!=="active"||!safeTokenEqual(input.token,action.tracking_token_hash))throw new Error("Invalid conversion token.");
  const occurred=assertFreshConversionTimestamp(input.occurredAt);
  if(input.assetId){const asset=await queryOne(`SELECT 1 FROM content_assets WHERE id=$1 AND workspace_id=$2`,[input.assetId,action.workspace_id]);if(!asset)throw new Error("Asset does not belong to this workspace.");}
  if(input.campaignId){const campaign=await queryOne(`SELECT 1 FROM content_campaigns WHERE id=$1 AND workspace_id=$2`,[input.campaignId,action.workspace_id]);if(!campaign)throw new Error("Campaign does not belong to this workspace.");}
  if(input.publicationId){const publication=await queryOne(`SELECT 1 FROM scheduled_posts sp JOIN content_assets ca ON ca.id=sp.content_asset_id WHERE sp.id=$1 AND ca.workspace_id=$2`,[input.publicationId,action.workspace_id]);if(!publication)throw new Error("Publication does not belong to this workspace.");}
  const existing=await queryOne<{id:string}>(`SELECT id FROM conversion_events WHERE workspace_id=$1 AND deduplication_key=$2`,[action.workspace_id,input.deduplicationKey]);
  if(existing)return {id:existing.id,duplicate:true};
  // Race-safe with UNIQUE (workspace_id, deduplication_key) from 0048 / 0056.
  const row=await queryOne<{id:string}>(
    `INSERT INTO conversion_events (workspace_id,conversion_action_id,content_asset_id,publication_id,campaign_id,event_type,value,currency,deduplication_key,metadata,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT (workspace_id, deduplication_key) DO NOTHING
     RETURNING id`,
    [action.workspace_id,input.actionId,input.assetId??null,input.publicationId??null,input.campaignId??null,input.eventType,input.value??null,input.currency?.toUpperCase().slice(0,3)??null,input.deduplicationKey.slice(0,200),JSON.stringify(input.metadata??{}),occurred.toISOString()]);
  if(!row){
    const raced=await queryOne<{id:string}>(`SELECT id FROM conversion_events WHERE workspace_id=$1 AND deduplication_key=$2`,[action.workspace_id,input.deduplicationKey]);
    if(raced)return {id:raced.id,duplicate:true};
    throw new Error("Could not record conversion event.");
  }
  if(input.publicationId)await query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'publication',$2,'conversion',$3,'produced_event') ON CONFLICT DO NOTHING`,[action.workspace_id,input.publicationId,row.id]);
  else if(input.assetId)await query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'asset',$2,'conversion',$3,'produced_event') ON CONFLICT DO NOTHING`,[action.workspace_id,input.assetId,row.id]);
  return {id:row.id,duplicate:false};
}

/** Workspace owner for conversion webhook rate limiting (rate_limits.user_id is a users FK). */
export async function conversionWebhookOwnerUserId(actionId:string):Promise<string|null>{
  const row=await queryOne<{user_id:string}>(
    `SELECT wm.user_id FROM conversion_actions ca
       JOIN workspace_members wm ON wm.workspace_id=ca.workspace_id AND wm.role='owner'
      WHERE ca.id=$1 LIMIT 1`,[actionId]);
  return row?.user_id??null;
}

export async function recordManualInfluence(userId:string,workspaceId:string,input:{actionId:string;assetId?:string|null;eventType:"lead"|"opportunity"|"revenue";externalOpportunityId?:string|null;value?:number|null;currency?:string|null;note?:string|null}):Promise<void>{
  await requireWorkspaceRole(userId,workspaceId,"editor");
  const action=await queryOne(`SELECT 1 FROM conversion_actions WHERE id=$1 AND workspace_id=$2`,[input.actionId,workspaceId]); if(!action)throw new Error("CTA not found.");
  if(input.assetId){const asset=await queryOne(`SELECT 1 FROM content_assets WHERE id=$1 AND workspace_id=$2`,[input.assetId,workspaceId]);if(!asset)throw new Error("Asset not found.");}
  const row=await queryOne<{id:string}>(`INSERT INTO conversion_events (workspace_id,conversion_action_id,content_asset_id,external_opportunity_id,event_type,influence_kind,value,currency,deduplication_key,metadata,occurred_at) VALUES ($1,$2,$3,$4,$5,'influenced',$6,$7,$8,$9::jsonb,now()) RETURNING id`,[workspaceId,input.actionId,input.assetId??null,input.externalOpportunityId??null,input.eventType,input.value??null,input.currency?.toUpperCase().slice(0,3)??null,`manual:${randomBytes(16).toString("hex")}`,JSON.stringify({note:input.note?.slice(0,1000)??null,recordedBy:userId})]);
  if(row&&input.assetId)await query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'asset',$2,$3,$4,'influenced') ON CONFLICT DO NOTHING`,[workspaceId,input.assetId,input.eventType==="opportunity"||input.eventType==="revenue"?"opportunity":"conversion",row.id]);
}

export async function listConversionEvents(userId:string,workspaceId:string):Promise<ConversionEventView[]> {
  await requireWorkspaceRole(userId,workspaceId,"viewer");
  const rows=await query<{id:string;action_name:string;asset_title:string|null;event_type:string;influence_kind:"observed"|"influenced";value:string|null;currency:string|null;occurred_at:string}>(`SELECT ce.id,ca.name action_name,a.title asset_title,ce.event_type,ce.influence_kind,ce.value::text,ce.currency,ce.occurred_at::text FROM conversion_events ce JOIN conversion_actions ca ON ca.id=ce.conversion_action_id LEFT JOIN content_assets a ON a.id=ce.content_asset_id WHERE ce.workspace_id=$1 ORDER BY ce.occurred_at DESC LIMIT 100`,[workspaceId]);
  return rows.map(row=>({id:row.id,actionName:row.action_name,assetTitle:row.asset_title,eventType:row.event_type,influenceKind:row.influence_kind,value:row.value===null?null:Number(row.value),currency:row.currency,occurredAt:row.occurred_at}));
}
