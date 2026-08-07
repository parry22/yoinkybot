import { z } from "zod";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { ensureBoss } from "../jobs/boss.js";
import { llmCall } from "../llm/gateway.js";
import { contentBriefPrompt } from "../prompts/content-brief.v1.js";
import { briefDraftPrompt } from "../prompts/brief-draft.v1.js";
import { narrativeCheckPrompt } from "../prompts/narrative-check.v1.js";
import { assetAtomizePrompt } from "../prompts/asset-atomize.v1.js";
import { schedulePost } from "../scheduling/service.js";
import { checkConsistency } from "../consistency/check.js";
import { requireWorkspaceRole, resolveDefaultExpert } from "../workspaces/service.js";
import { createWorkspaceAudience } from "../narrative/service.js";
import { CONTENT_ASSET_TYPES, type AssetCheckResult, type ContentAssetType, type ContentAssetView, type ContentBriefView } from "./types.js";

export type StudioGenerateInput = {
  channel?: "x" | "linkedin";
  format?: ContentAssetType;
  knowledgeObjectIds?: string[];
  userPrompt?: string;
  tone?: string;
};

const briefSchema = z.object({
  objective: z.string().min(5).max(1000),
  audience_id: z.string().uuid(),
  buying_stage: z.string().min(2).max(80),
  territory_name: z.string().max(120).catch(""),
  desired_belief_shift: z.string().min(10).max(1000),
  core_insight_id: z.string().uuid(),
  supporting_claim_id: z.string().uuid(),
  primary_proof_id: z.string().uuid(),
  source_ids: z.array(z.string().uuid()).min(1).max(12),
  format: z.string().min(2).max(100),
  primary_emotion: z.string().max(100).catch(""),
  reason_now: z.string().max(700).catch(""),
  cta: z.string().max(300).catch(""),
});

const assetSchema = z.object({ title: z.string().max(180).catch(""), content: z.string().min(20).max(20_000) });
const checkSchema = z.object({
  narrative_aligned: z.boolean().catch(false),
  unsupported_claims: z.array(z.string().max(500)).max(10).catch([]),
  explanation: z.string().max(1000).catch(""),
});
const atomizedSchema = z.object({
  assets: z.array(z.object({
    asset_type: z.enum(CONTENT_ASSET_TYPES),
    title: z.string().max(180).catch(""),
    content: z.string().min(20).max(30_000),
  })).min(1).max(8),
});

interface BriefRow {
  id: string; workspace_id: string; objective: string; audience_id:string; audience_name:string; buying_stage: string; territory_name: string | null;
  supporting_claim:string; primary_proof:string;
  desired_belief_shift: string; channel: "x" | "linkedin"; format: string; primary_emotion: string | null;
  reason_now: string | null; cta_text:string|null; campaign_name:string|null; status: ContentBriefView["status"]; source_count: string;
}

interface AssetRow {
  id: string; workspace_id: string; brief_id: string; asset_type: ContentAssetType; parent_asset_id: string | null;
  title: string; status: ContentAssetView["status"]; content: string; version: number;
  check_results: AssetCheckResult | Record<string, never>; source_count: string; created_at: string;
  scheduled_for: string | null;
}

function mapBrief(row: BriefRow): ContentBriefView {
  return { id: row.id, workspaceId: row.workspace_id, objective: row.objective, audienceId:row.audience_id,audienceName:row.audience_name,buyingStage: row.buying_stage,
    territoryName: row.territory_name, desiredBeliefShift: row.desired_belief_shift, channel: row.channel,
    supportingClaim:row.supporting_claim,primaryProof:row.primary_proof,
    format: row.format, primaryEmotion: row.primary_emotion, reasonNow: row.reason_now, status: row.status,
    ctaText:row.cta_text,campaignName:row.campaign_name,
    sourceCount: Number(row.source_count) };
}

function mapAsset(row: AssetRow): ContentAssetView {
  const checks = row.check_results && "status" in row.check_results ? row.check_results as AssetCheckResult : null;
  return { id: row.id, workspaceId: row.workspace_id, briefId: row.brief_id, assetType: row.asset_type,
    parentAssetId: row.parent_asset_id,
    title: row.title, status: row.status, content: row.content, version: Number(row.version), checks,
    sourceCount: Number(row.source_count),
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at };
}

export async function listContentBriefs(userId: string, workspaceId: string): Promise<ContentBriefView[]> {
  await requireWorkspaceRole(userId, workspaceId, "viewer");
  const rows = await query<BriefRow>(
    `SELECT cb.id, cb.workspace_id, cb.objective, cb.audience_id,wa.name audience_name,cb.buying_stage, et.name AS territory_name,
            cr.claim_text supporting_claim,proof.title primary_proof,
            cb.desired_belief_shift, cb.channel, cb.format, cb.primary_emotion, cb.reason_now,
            cb.cta_text,cc.name campaign_name,cb.status, count(cbs.knowledge_object_id)::text AS source_count
       FROM content_briefs cb
       JOIN workspace_audiences wa ON wa.id=cb.audience_id AND wa.workspace_id=cb.workspace_id
       JOIN claim_registry cr ON cr.id=cb.primary_claim_id AND cr.workspace_id=cb.workspace_id
       JOIN knowledge_objects proof ON proof.id=cb.primary_proof_id AND proof.workspace_id=cb.workspace_id
       LEFT JOIN editorial_territories et ON et.id = cb.territory_id
       LEFT JOIN content_campaigns cc ON cc.id=cb.campaign_id AND cc.workspace_id=cb.workspace_id
       LEFT JOIN content_brief_sources cbs ON cbs.content_brief_id = cb.id
      WHERE cb.workspace_id = $1
      GROUP BY cb.id,wa.name,cr.claim_text,proof.title,et.name,cc.name ORDER BY cb.created_at DESC`,
    [workspaceId],
  );
  return rows.map(mapBrief);
}

async function generateOneBrief(
  userId: string,
  workspaceId: string,
  channel: "x" | "linkedin",
  excludedInsightIds: string[] = [],
  options: { knowledgeObjectIds?: string[]; userPrompt?: string; preferredFormat?: string } = {},
): Promise<ContentBriefView> {
  const workspace = await requireWorkspaceRole(userId, workspaceId, "contributor");
  const narrative = await queryOne<{ id: string; category_thesis: string; point_of_view: string; primary_promise: string }>(
    `SELECT id, category_thesis, point_of_view, primary_promise FROM narrative_systems
      WHERE workspace_id = $1 AND status = 'active'`, [workspaceId]);
  if (!narrative) throw new Error("Activate a narrative before generating briefs.");
  const territories = await query<{ id: string; name: string }>(
    `SELECT id, name FROM editorial_territories WHERE workspace_id=$1 AND narrative_system_id=$2 AND status='active'`,
    [workspaceId, narrative.id]);
  const [audiences,journey,campaigns,actions,performance]=await Promise.all([
    query<{id:string;name:string;description:string|null}>(`SELECT id,name,description FROM workspace_audiences WHERE workspace_id=$1 ORDER BY created_at LIMIT 20`,[workspaceId]),
    query<{audience:string;stage:string;question:string}>(`SELECT coalesce(wa.name,'All audiences') audience,bjq.stage,bjq.question FROM buyer_journey_questions bjq LEFT JOIN workspace_audiences wa ON wa.id=bjq.audience_id AND wa.workspace_id=bjq.workspace_id WHERE bjq.workspace_id=$1 AND bjq.status='open' ORDER BY priority DESC LIMIT 20`,[workspaceId]),
    query<{id:string;name:string;objective:string}>(`SELECT id,name,objective FROM content_campaigns WHERE workspace_id=$1 AND status='active' ORDER BY start_at DESC LIMIT 8`,[workspaceId]),
    query<{id:string;name:string;action_type:string}>(`SELECT id,name,action_type FROM conversion_actions WHERE workspace_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 20`,[workspaceId]),
    query<{summary:string}>(`SELECT concat(et.name,': ',count(*) FILTER(WHERE sp.status='published'),' published, ',count(ce.id),' conversions') summary FROM editorial_territories et LEFT JOIN content_briefs cb ON cb.territory_id=et.id LEFT JOIN content_assets ca ON ca.brief_id=cb.id LEFT JOIN scheduled_posts sp ON sp.content_asset_id=ca.id LEFT JOIN conversion_events ce ON ce.content_asset_id=ca.id AND ce.workspace_id=et.workspace_id WHERE et.workspace_id=$1 GROUP BY et.id ORDER BY count(ce.id) DESC LIMIT 8`,[workspaceId]),
  ]);
  if(audiences.length===0)throw new Error("Add at least one target audience before generating briefs.");
  const preferredIds = [...new Set((options.knowledgeObjectIds ?? []).filter(Boolean))].slice(0, 12);
  const knowledge = await query<{ id: string; object_type: string; title: string; body: string; use_count:string }>(
    `SELECT ko.id, ko.object_type, ko.title, ko.body,count(cbs.content_brief_id)::text use_count
       FROM knowledge_objects ko
       LEFT JOIN claim_registry cr ON cr.workspace_id=ko.workspace_id AND cr.knowledge_object_id=ko.id
       LEFT JOIN content_brief_sources cbs ON cbs.workspace_id=ko.workspace_id AND cbs.knowledge_object_id=ko.id
      WHERE ko.workspace_id=$1 AND ko.status='approved'
        AND ko.permission_level IN ('public','internal')
        AND (ko.object_type <> 'claim' OR cr.approval_status='approved')
        AND NOT (ko.id=ANY($2::uuid[]))
      GROUP BY ko.id
      ORDER BY CASE WHEN ko.id = ANY($3::uuid[]) THEN 0 ELSE 1 END,
               count(cbs.content_brief_id),ko.confidence DESC,ko.created_at DESC
      LIMIT 50`, [workspaceId, excludedInsightIds, preferredIds]);
  if(!knowledge.some(item=>item.object_type==="insight")||!knowledge.some(item=>item.object_type==="claim")||!knowledge.some(item=>item.object_type==="proof"))throw new Error("Briefs need at least one approved insight, approved claim and approved proof.");
  const response = await llmCall({
    userId, eventType: "brief_generate", tier: contentBriefPrompt.tier, system: contentBriefPrompt.system,
    user: contentBriefPrompt.render({
      objective: workspace.primaryObjective ?? "Build category authority",
      narrative: `${narrative.category_thesis}\n${narrative.point_of_view}\n${narrative.primary_promise}`,
      territories: territories.map((territory) => territory.name),
      knowledge: knowledge.map((item) => ({ id: item.id, type: item.object_type, title: item.title, body: item.body })),
      preferredKnowledgeIds: preferredIds,
      userPrompt: options.userPrompt,
      audiences,
      journeyGaps:journey,
      campaignNeeds:campaigns.map(item=>`${item.name}: ${item.objective}`),
      performanceEvidence:performance.map(item=>item.summary),
      marketContext:knowledge.filter(item=>item.object_type==="market_signal").map(item=>`${item.title}: ${item.body}`),
      channel,
    }), json: true, maxTokens: 1800,
  });
  const proposal = briefSchema.parse(response.parsed);
  const eligible = new Map(knowledge.map((item) => [item.id, item]));
  const preferredInsight = preferredIds.map((id) => eligible.get(id)).find((item) => item?.object_type === "insight");
  const preferredClaim = preferredIds.map((id) => eligible.get(id)).find((item) => item?.object_type === "claim");
  const preferredProof = preferredIds.map((id) => eligible.get(id)).find((item) => item?.object_type === "proof");
  const core = preferredInsight ?? eligible.get(proposal.core_insight_id);
  if (!core || core.object_type !== "insight") throw new Error("The generated brief did not select an eligible insight.");
  const claim = preferredClaim ?? eligible.get(proposal.supporting_claim_id);
  if (!claim || claim.object_type !== "claim") throw new Error("The generated brief did not select an approved claim.");
  const proof = preferredProof ?? eligible.get(proposal.primary_proof_id);
  if (!proof || proof.object_type !== "proof") throw new Error("The generated brief did not select concrete proof.");
  const audience=audiences.find(item=>item.id===proposal.audience_id);if(!audience)throw new Error("The generated brief did not select an eligible audience.");
  const claimRegistry = await queryOne<{ id: string }>(
    `SELECT id FROM claim_registry
      WHERE workspace_id = $1 AND knowledge_object_id = $2 AND approval_status = 'approved'`,
    [workspaceId, claim.id],
  );
  if (!claimRegistry) throw new Error("Approve the supporting claim in the claim registry before generating briefs.");
  const selected = [...new Set([core.id,claim.id,proof.id, ...preferredIds.filter((id) => eligible.has(id)), ...proposal.source_ids.filter((id) => eligible.has(id))])];
  const territory = territories.find((item) => item.name.toLowerCase() === proposal.territory_name.toLowerCase()) ?? territories[0] ?? null;
  const format = options.preferredFormat?.replaceAll("_", " ") || proposal.format;

  const id = await withTransaction(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO content_briefs
         (workspace_id, objective,audience_id,buying_stage, territory_id,campaign_id, desired_belief_shift,
          core_insight_object_id,primary_claim_id, primary_proof_id, channel, format, primary_emotion,
          cta_text,cta_id, reason_now, status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17) RETURNING id`,
      [workspaceId, proposal.objective,audience.id,proposal.buying_stage, territory?.id ?? null,campaigns[0]?.id??null,
       proposal.desired_belief_shift, core.id,claimRegistry.id,proof.id,channel,format,
       proposal.primary_emotion || null, proposal.cta || null,actions[0]?.id??null, proposal.reason_now || null, userId],
    );
    const briefId = row.rows[0]?.id;
    if (!briefId) throw new Error("Could not save content brief.");
    for (const sourceId of selected) {
      const source = eligible.get(sourceId)!;
      const usageRole = sourceId === core.id ? "core_insight" : sourceId===claim.id?"claim":source.object_type === "proof" ? "proof" :
        source.object_type === "story" ? "story" : source.object_type === "customer_quote" || source.object_type === "language_phrase" ? "customer_language" : "context";
      await client.query(`INSERT INTO content_brief_sources (workspace_id, content_brief_id, knowledge_object_id, usage_role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [workspaceId, briefId, sourceId, usageRole]);
      await client.query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'knowledge_object',$2,'brief',$3,'grounds') ON CONFLICT DO NOTHING`, [workspaceId, sourceId, briefId]);
    }
    return briefId;
  });
  const all = await listContentBriefs(userId, workspaceId);
  const brief = all.find((item) => item.id === id);
  if (!brief) throw new Error("Could not reload content brief.");
  return brief;
}

export async function generateBriefOptions(
  userId: string,
  workspaceId: string,
  input: {
    channel?: "x" | "linkedin" | "both";
    count?: number;
    knowledgeObjectIds?: string[];
    userPrompt?: string;
    preferredFormat?: string;
  } = {},
): Promise<ContentBriefView[]> {
  const count = Math.max(1, Math.min(4, input.count ?? 3));
  const channel = input.channel ?? "both";
  const results: ContentBriefView[] = [];
  const used: string[] = [];
  for (let index = 0; index < count; index++) {
    const nextChannel = channel === "both" ? (index % 2 === 0 ? "linkedin" : "x") : channel;
    const brief = await generateOneBrief(userId, workspaceId, nextChannel, used, {
      knowledgeObjectIds: input.knowledgeObjectIds,
      userPrompt: input.userPrompt,
      preferredFormat: input.preferredFormat,
    });
    results.push(brief);
    const insight = await queryOne<{ id: string }>(
      `SELECT core_insight_object_id id FROM content_briefs WHERE id=$1 AND workspace_id=$2`,
      [brief.id, workspaceId],
    );
    if (insight) used.push(insight.id);
  }
  return results;
}

export async function generateLinkedInBrief(userId:string,workspaceId:string):Promise<ContentBriefView>{return (await generateBriefOptions(userId,workspaceId,{channel:"linkedin",count:1}))[0]!;}

export async function approveContentBrief(userId: string, workspaceId: string, briefId: string): Promise<ContentBriefView> {
  await requireWorkspaceRole(userId, workspaceId, "editor");
  const row = await queryOne<{ id: string }>(
    `UPDATE content_briefs SET status='ready', approved_by_user_id=$1, updated_at=now()
      WHERE id=$2 AND workspace_id=$3 AND status='draft' RETURNING id`, [userId, briefId, workspaceId]);
  if (!row) throw new Error("Only a draft brief in this workspace can be approved.");
  return (await listContentBriefs(userId, workspaceId)).find((item) => item.id === briefId)!;
}

export async function updateContentBrief(userId:string,workspaceId:string,briefId:string,input:{objective:string;desiredBeliefShift:string;buyingStage:string;format:string;ctaText?:string|null}):Promise<ContentBriefView>{
  await requireWorkspaceRole(userId,workspaceId,"contributor");
  const row=await queryOne<{id:string}>(`UPDATE content_briefs SET objective=$3,desired_belief_shift=$4,buying_stage=$5,format=$6,cta_text=$7,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status IN ('idea','draft') RETURNING id`,[briefId,workspaceId,input.objective.trim().slice(0,1000),input.desiredBeliefShift.trim().slice(0,1000),input.buyingStage.trim().slice(0,80),input.format.trim().slice(0,100),input.ctaText?.trim().slice(0,300)||null]);if(!row)throw new Error("Only a draft brief in this workspace can be edited.");return (await listContentBriefs(userId,workspaceId)).find(item=>item.id===briefId)!;
}

export async function listContentAssets(userId: string, workspaceId: string): Promise<ContentAssetView[]> {
  await requireWorkspaceRole(userId, workspaceId, "viewer");
  const rows = await query<AssetRow>(
    `SELECT ca.id,ca.workspace_id,ca.brief_id,ca.asset_type,ca.parent_asset_id,ca.title,ca.status,
            cav.content,cav.version,ca.check_results,
            (SELECT count(*)::text FROM content_brief_sources cbs WHERE cbs.content_brief_id=ca.brief_id) AS source_count,
            ca.created_at::text,
            (SELECT min(sp.scheduled_for)::text
               FROM scheduled_posts sp
              WHERE sp.content_asset_id = ca.id
                AND sp.workspace_id = ca.workspace_id
                AND sp.status = 'pending') AS scheduled_for
       FROM content_assets ca
       JOIN LATERAL (SELECT content,version FROM content_asset_versions WHERE asset_id=ca.id ORDER BY version DESC LIMIT 1) cav ON true
      WHERE ca.workspace_id=$1 ORDER BY ca.created_at DESC`, [workspaceId]);
  return rows.map(mapAsset);
}

export async function draftFromBrief(userId: string, workspaceId: string, briefId: string): Promise<ContentAssetView> {
  const workspace = await requireWorkspaceRole(userId, workspaceId, "contributor");
  const brief = await queryOne<{ objective:string; desired_belief_shift:string; channel:"x"|"linkedin"; format:string; cta_text:string|null; status:string; audience_name:string }>(
    `SELECT cb.objective,cb.desired_belief_shift,cb.channel,cb.format,cb.cta_text,cb.status,wa.name audience_name FROM content_briefs cb JOIN workspace_audiences wa ON wa.id=cb.audience_id AND wa.workspace_id=cb.workspace_id WHERE cb.id=$1 AND cb.workspace_id=$2`, [briefId, workspaceId]);
  if (!brief || brief.status !== "ready") throw new Error("Approve the brief before drafting.");
  const narrative = await queryOne<{ category_thesis:string; point_of_view:string; unique_mechanism:string; primary_promise:string }>(
    `SELECT category_thesis,point_of_view,unique_mechanism,primary_promise FROM narrative_systems WHERE workspace_id=$1 AND status='active'`, [workspaceId]);
  if (!narrative) throw new Error("No active narrative.");
  const sources = await query<{ id:string; object_type:string; body:string; permission_level:string; status:string }>(
    `SELECT ko.id,ko.object_type,ko.body,ko.permission_level,ko.status FROM content_brief_sources cbs
      JOIN knowledge_objects ko ON ko.id=cbs.knowledge_object_id AND ko.workspace_id=$2 WHERE cbs.content_brief_id=$1`, [briefId, workspaceId]);
  if (sources.length === 0 || sources.some((source) => source.status !== "approved" || !["public","internal"].includes(source.permission_level))) throw new Error("Brief sources are no longer eligible for generation.");
  const expert = await resolveDefaultExpert(userId, workspaceId);
  if (!expert) throw new Error("Set a default expert before drafting.");
  const expertVoice=await queryOne<{traits:Record<string,unknown>}>(`SELECT traits FROM expert_voice_profiles WHERE expert_id=$1 AND workspace_id=$2 ORDER BY version DESC LIMIT 1`,[expert.id,workspaceId]);
  const personalVoice = !expertVoice&&expert.linkedUserId ? await queryOne<{ traits: Record<string, unknown> }>(
    `SELECT traits FROM voice_profiles WHERE user_id=$1 ORDER BY version DESC LIMIT 1`, [expert.linkedUserId]) : null;
  const voice=expertVoice??personalVoice;
  const performance=await query<{summary:string}>(`SELECT concat(ca.asset_type,': ',count(*) FILTER(WHERE sp.status='published'),' published') summary FROM content_assets ca LEFT JOIN scheduled_posts sp ON sp.content_asset_id=ca.id WHERE ca.workspace_id=$1 GROUP BY ca.asset_type`,[workspaceId]);
  const response = await llmCall({
    userId,eventType:"brief_draft",tier:briefDraftPrompt.tier,system:briefDraftPrompt.system,
    user:briefDraftPrompt.render({ workspace:workspace.name,
      narrative:`${narrative.category_thesis}\n${narrative.point_of_view}\n${narrative.unique_mechanism}\n${narrative.primary_promise}`,
      expert:`${expert.name}${expert.title ? `, ${expert.title}` : ""}`,
      voice:voice ? JSON.stringify(voice.traits) : "Use the speaker's phrasing in the approved source material.",
      audience:brief.audience_name,
      approvedClaims:sources.filter(source=>source.object_type==="claim").map(source=>source.body),
      proof:sources.filter(source=>source.object_type==="proof").map(source=>source.body),
      channelRules:brief.channel==="linkedin"?"Professional utility, credible whitespace, no engagement bait and at most three hashtags.":"Concise, sharp and native to X.",
      performanceEvidence:performance.map(item=>item.summary),
      marketContext:sources.filter(source=>source.object_type==="market_signal").map(source=>source.body),
      objective:brief.objective,beliefShift:brief.desired_belief_shift,channel:brief.channel,format:brief.format,
      cta:brief.cta_text ?? "Invite a relevant reply",sources:sources.map((source)=>({type:source.object_type,body:source.body})),
    }),json:true,maxTokens:2200,
  });
  const generated = assetSchema.parse(response.parsed);
  const content = generated.content.replace(/—/g, ",");
  const assetId = await withTransaction(async (client) => {
    const row = await client.query<{id:string}>(
      `INSERT INTO content_assets (workspace_id,brief_id,expert_id,asset_type,title,status,created_by)
       VALUES ($1,$2,$3,$4,$5,'needs_review','model') RETURNING id`,
      [workspaceId,briefId,expert.id,brief.channel === "linkedin" ? "linkedin_post" : "x_post",generated.title.trim() || brief.objective.slice(0, 180)]);
    const id = row.rows[0]?.id;
    if (!id) throw new Error("Could not save content asset.");
    await client.query(`INSERT INTO content_asset_versions (asset_id,version,content,created_by_model,change_summary) VALUES ($1,1,$2,$3,'Initial brief-driven draft')`, [id,content,"grok-4.3"]);
    await client.query(`UPDATE content_briefs SET status='in_production',updated_at=now() WHERE id=$1`, [briefId]);
    await client.query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'brief',$2,'asset',$3,'produced') ON CONFLICT DO NOTHING`, [workspaceId,briefId,id]);
    return id;
  });
  await runAssetChecks(userId, workspaceId, assetId);
  return (await listContentAssets(userId, workspaceId)).find((item)=>item.id===assetId)!;
}

export async function atomizeContentAsset(
  userId: string,
  workspaceId: string,
  assetId: string,
  targetFormats: ContentAssetType[],
): Promise<ContentAssetView[]> {
  const workspace = await requireWorkspaceRole(userId, workspaceId, "contributor");
  const requested = [...new Set(targetFormats)].filter((format): format is ContentAssetType => CONTENT_ASSET_TYPES.includes(format));
  if (requested.length === 0 || requested.length > 6) throw new Error("Choose between one and six supported target formats.");
  const source = await queryOne<{ brief_id:string; content:string; title:string; status:string }>(
    `SELECT ca.brief_id,ca.title,ca.status,cav.content
       FROM content_assets ca
       JOIN LATERAL (SELECT content FROM content_asset_versions WHERE asset_id=ca.id ORDER BY version DESC LIMIT 1)cav ON true
      WHERE ca.id=$1 AND ca.workspace_id=$2`, [assetId, workspaceId]);
  if (!source || !["approved","scheduled","published"].includes(source.status)) throw new Error("Approve the source asset before creating derivatives.");
  const brief = await queryOne<{ objective:string;desired_belief_shift:string;format:string;cta_text:string|null }>(
    `SELECT objective,desired_belief_shift,format,cta_text FROM content_briefs WHERE id=$1 AND workspace_id=$2`, [source.brief_id,workspaceId]);
  if (!brief) throw new Error("The source brief is unavailable.");
  const narrative = await queryOne<{text:string}>(
    `SELECT concat_ws(E'\n',category_thesis,problem_narrative,point_of_view,unique_mechanism,primary_promise) text FROM narrative_systems WHERE workspace_id=$1 AND status='active'`, [workspaceId]);
  if (!narrative) throw new Error("No active narrative.");
  const sources = await query<{object_type:string;body:string;permission_level:string;status:string}>(
    `SELECT ko.object_type,ko.body,ko.permission_level,ko.status FROM content_brief_sources cbs
      JOIN knowledge_objects ko ON ko.id=cbs.knowledge_object_id AND ko.workspace_id=$2 WHERE cbs.content_brief_id=$1`, [source.brief_id,workspaceId]);
  if (sources.length === 0 || sources.some(item=>item.status!=="approved" || !["public","internal"].includes(item.permission_level))) {
    throw new Error("All source knowledge must remain approved and cleared for generation.");
  }
  const response = await llmCall({
    userId,eventType:"asset_atomize",tier:assetAtomizePrompt.tier,system:assetAtomizePrompt.system,
    user:assetAtomizePrompt.render({workspace:workspace.name,narrative:narrative.text,sourceAsset:source.content,
      brief:`Objective: ${brief.objective}\nBelief shift: ${brief.desired_belief_shift}\nFormat: ${brief.format}\nCTA: ${brief.cta_text??"None"}`,
      sources:sources.map(item=>({type:item.object_type,body:item.body})),targetFormats:requested}),json:true,maxTokens:5000,
  });
  const generated = atomizedSchema.parse(response.parsed).assets;
  const byType = new Map(generated.map(item=>[item.asset_type,item]));
  for (const target of requested) if (!byType.has(target)) throw new Error(`The model did not return the requested ${target.replaceAll("_"," ")} derivative.`);
  const createdIds = await withTransaction(async client => {
    const ids:string[]=[];
    for (const target of requested) {
      const item=byType.get(target)!;
      const row=await client.query<{id:string}>(
        `INSERT INTO content_assets (workspace_id,brief_id,asset_type,title,status,parent_asset_id,created_by)
         VALUES ($1,$2,$3,$4,'needs_review',$5,'model') RETURNING id`,
        [workspaceId,source.brief_id,target,item.title.trim()||`${source.title} derivative`,assetId]);
      const id=row.rows[0]?.id; if(!id)throw new Error("Could not save derivative.");
      await client.query(`INSERT INTO content_asset_versions (asset_id,version,content,created_by_model,change_summary) VALUES ($1,1,$2,$3,$4)`,
        [id,item.content.replace(/—/g,","),"grok-4.3",`Channel-native derivative of ${assetId}`]);
      await client.query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'brief',$2,'asset',$3,'produced') ON CONFLICT DO NOTHING`,[workspaceId,source.brief_id,id]);
      await client.query(`INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type) VALUES ($1,'asset',$2,'asset',$3,'atomized_into') ON CONFLICT DO NOTHING`,[workspaceId,assetId,id]);
      ids.push(id);
    }
    return ids;
  });
  for (const id of createdIds) await runAssetChecks(userId,workspaceId,id);
  const assets=await listContentAssets(userId,workspaceId);
  return createdIds.map(id=>assets.find(asset=>asset.id===id)).filter((asset):asset is ContentAssetView=>!!asset);
}

export async function runAssetChecks(userId:string,workspaceId:string,assetId:string):Promise<AssetCheckResult>{
  await requireWorkspaceRole(userId,workspaceId,"contributor");
  const asset=await queryOne<{content:string;brief_id:string;asset_type:string;linked_user_id:string|null}>(`SELECT cav.content,ca.brief_id,ca.asset_type,e.linked_user_id FROM content_assets ca LEFT JOIN experts e ON e.id=ca.expert_id AND e.workspace_id=ca.workspace_id JOIN LATERAL (SELECT content FROM content_asset_versions WHERE asset_id=ca.id ORDER BY version DESC LIMIT 1)cav ON true WHERE ca.id=$1 AND ca.workspace_id=$2`,[assetId,workspaceId]);
  if(!asset) throw new Error("Asset not found.");
  const narrative=await queryOne<{text:string}>(`SELECT concat_ws(E'\n',category_thesis,problem_narrative,point_of_view,unique_mechanism,primary_promise) text FROM narrative_systems WHERE workspace_id=$1 AND status='active'`,[workspaceId]);
  const sources=await query<{body:string;object_type:string;permission_level:string;claim_status:string|null;risk_level:string|null;evidence_object_ids:string[]|null;expires_at:string|null;allowed_contexts:string[]|null;prohibited_contexts:string[]|null}>(`SELECT ko.body,ko.object_type,ko.permission_level,cr.approval_status claim_status,cr.risk_level,cr.evidence_object_ids,cr.expires_at::text,cr.allowed_contexts,cr.prohibited_contexts FROM content_brief_sources cbs JOIN knowledge_objects ko ON ko.id=cbs.knowledge_object_id AND ko.workspace_id=$2 LEFT JOIN claim_registry cr ON cr.workspace_id=ko.workspace_id AND cr.knowledge_object_id=ko.id WHERE cbs.content_brief_id=$1`,[asset.brief_id,workspaceId]);
  const prohibited=await query<{claim_text:string;prohibited_contexts:string[]}>(`SELECT claim_text,prohibited_contexts FROM claim_registry WHERE workspace_id=$1 AND approval_status='prohibited'`,[workspaceId]);
  const issues:string[]=[];
  let status:AssetCheckResult["status"]="clear";
  if(sources.some(source=>["confidential","restricted","never_use_for_generation"].includes(source.permission_level))){status="confidential_source";issues.push("A source is not cleared for public generation.");}
  const unapprovedClaim=sources.find(source=>source.object_type==="claim"&&source.claim_status!=="approved");
  if(unapprovedClaim){status="unsupported_claim";issues.push("The brief uses a claim that is not approved in the claim registry.");}
  const expired=sources.find(source=>source.object_type==="claim"&&source.expires_at&&new Date(source.expires_at)<=new Date());
  if(expired){status="unsupported_claim";issues.push("An approved claim has expired and must be reviewed again.");}
  const riskyWithoutEvidence=sources.find(source=>source.object_type==="claim"&&["high","regulated"].includes(source.risk_level??"")&&!(source.evidence_object_ids?.length));
  if(riskyWithoutEvidence){status="unsupported_claim";issues.push("A high-risk claim has no approved evidence record.");}
  const channel=asset.asset_type==="linkedin_post"?"linkedin":"x";
  const contextBlocked=sources.find(source=>source.object_type==="claim"&&source.prohibited_contexts?.includes(channel));
  if(contextBlocked){status="prohibited_claim";issues.push(`A claim is prohibited on ${channel}.`);}
  const prohibitedUse=prohibited.find(item=>asset.content.toLowerCase().includes(item.claim_text.toLowerCase())&&(!item.prohibited_contexts.length||item.prohibited_contexts.includes(channel)));
  if(prohibitedUse){status="prohibited_claim";issues.push("The draft repeats a claim the workspace has prohibited.");}
  if(asset.linked_user_id&&status==="clear"){
    const consistency=await checkConsistency(asset.linked_user_id,asset.content);
    if(!consistency.clear){status="position_conflict";issues.push(...consistency.flags.map(flag=>flag.explanation));}
  }
  if(narrative&&status==="clear"){
    const response=await llmCall({userId,eventType:"narrative_check",tier:narrativeCheckPrompt.tier,system:narrativeCheckPrompt.system,user:narrativeCheckPrompt.render({narrative:narrative.text,draft:asset.content,sources:sources.map(source=>source.body)}),json:true,maxTokens:900});
    const checked=checkSchema.parse(response.parsed);
    if(!checked.narrative_aligned){status="narrative_drift";issues.push(checked.explanation||"Draft drifts from the active narrative.");}
    else if(checked.unsupported_claims.length){status="unsupported_claim";issues.push(...checked.unsupported_claims);}
  }
  const result:AssetCheckResult={status,issues,checkedAt:new Date().toISOString()};
  await query(`UPDATE content_assets SET check_results=$3::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2`,[assetId,workspaceId,JSON.stringify(result)]);
  return result;
}

export async function approveContentAsset(userId:string,workspaceId:string,assetId:string,note?:string):Promise<ContentAssetView>{
  await requireWorkspaceRole(userId,workspaceId,"editor");
  const risk=await queryOne<{high_risk:boolean}>(`SELECT bool_or(cr.risk_level IN ('high','regulated')) high_risk FROM content_assets ca JOIN content_brief_sources cbs ON cbs.content_brief_id=ca.brief_id AND cbs.workspace_id=ca.workspace_id JOIN claim_registry cr ON cr.knowledge_object_id=cbs.knowledge_object_id AND cr.workspace_id=ca.workspace_id WHERE ca.id=$1 AND ca.workspace_id=$2`,[assetId,workspaceId]);
  if(risk?.high_risk)await requireWorkspaceRole(userId,workspaceId,"admin");
  const checks=await runAssetChecks(userId,workspaceId,assetId);
  if(checks.status!=="clear") throw new Error(`This asset cannot be approved: ${checks.issues.join(" ")}`);
  const row=await queryOne<{id:string}>(`UPDATE content_assets SET status='approved',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='needs_review' RETURNING id`,[assetId,workspaceId]);
  if(!row) throw new Error("Only an asset awaiting review can be approved.");
  await query(`INSERT INTO asset_reviews (workspace_id,asset_id,reviewer_user_id,decision,note) VALUES ($1,$2,$3,'approved',$4)`,[workspaceId,assetId,userId,note?.trim().slice(0,1000)||null]);
  await query(`INSERT INTO workspace_audit_logs (workspace_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,'asset.approved','asset',$3,jsonb_build_object('note',$4::text))`,[workspaceId,userId,assetId,note?.trim().slice(0,1000)||null]);
  return (await listContentAssets(userId,workspaceId)).find(item=>item.id===assetId)!;
}

export async function rejectContentAsset(userId:string,workspaceId:string,assetId:string,note?:string):Promise<ContentAssetView>{
  await requireWorkspaceRole(userId,workspaceId,"editor");
  const row=await queryOne<{id:string}>(`UPDATE content_assets SET status='rejected',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','needs_review') RETURNING id`,[assetId,workspaceId]);
  if(!row)throw new Error("Only a draft in this workspace can be rejected.");
  await query(`INSERT INTO asset_reviews (workspace_id,asset_id,reviewer_user_id,decision,note) VALUES ($1,$2,$3,'rejected',$4)`,[workspaceId,assetId,userId,note?.trim().slice(0,1000)||null]);
  return (await listContentAssets(userId,workspaceId)).find(item=>item.id===assetId)!;
}

export async function reviewContentAsset(userId:string,workspaceId:string,assetId:string,decision:"changes_requested"|"comment",note:string):Promise<ContentAssetView>{
  await requireWorkspaceRole(userId,workspaceId,"editor");
  const clean=note.trim().slice(0,1000);if(!clean)throw new Error("Add a review note.");
  const asset=await queryOne<{id:string}>(`SELECT id FROM content_assets WHERE id=$1 AND workspace_id=$2`,[assetId,workspaceId]);if(!asset)throw new Error("Asset not found in this workspace.");
  if(decision==="changes_requested")await query(`UPDATE content_assets SET status='draft',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='needs_review'`,[assetId,workspaceId]);
  await query(`INSERT INTO asset_reviews (workspace_id,asset_id,reviewer_user_id,decision,note) VALUES ($1,$2,$3,$4,$5)`,[workspaceId,assetId,userId,decision,clean]);
  return (await listContentAssets(userId,workspaceId)).find(item=>item.id===assetId)!;
}

export async function reviseContentAsset(userId:string,workspaceId:string,assetId:string,content:string,changeSummary?:string):Promise<ContentAssetView>{
  await requireWorkspaceRole(userId,workspaceId,"contributor");const clean=content.trim().replace(/—/g,",");if(clean.length<20||clean.length>30_000)throw new Error("Draft content must be between 20 and 30,000 characters.");
  await withTransaction(async client=>{const asset=await client.query<{id:string}>(`SELECT id FROM content_assets WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','needs_review','rejected') FOR UPDATE`,[assetId,workspaceId]);if(!asset.rows[0])throw new Error("This asset is not editable.");const version=await client.query<{next:number}>(`SELECT coalesce(max(version),0)+1 next FROM content_asset_versions WHERE asset_id=$1`,[assetId]);await client.query(`INSERT INTO content_asset_versions (asset_id,version,content,created_by_user_id,change_summary) VALUES ($1,$2,$3,$4,$5)`,[assetId,version.rows[0]?.next??1,clean,userId,changeSummary?.trim().slice(0,300)||"Editorial revision"]);await client.query(`UPDATE content_assets SET status='needs_review',updated_at=now() WHERE id=$1`,[assetId]);});
  await runAssetChecks(userId,workspaceId,assetId);return (await listContentAssets(userId,workspaceId)).find(item=>item.id===assetId)!;
}

export async function scheduleContentAsset(
  userId: string,
  workspaceId: string,
  assetId: string,
  scheduledFor: string,
  platforms?: Array<"x" | "linkedin">,
): Promise<{ id: string; platform: "x" | "linkedin" }[]> {
  await requireWorkspaceRole(userId, workspaceId, "editor");
  const asset = await queryOne<{ content: string; status: string; asset_type: string }>(
    `SELECT cav.content,ca.status,ca.asset_type FROM content_assets ca
       JOIN LATERAL (SELECT content FROM content_asset_versions WHERE asset_id=ca.id ORDER BY version DESC LIMIT 1)cav ON true
      WHERE ca.id=$1 AND ca.workspace_id=$2`,
    [assetId, workspaceId],
  );
  if (!asset || asset.status !== "approved") throw new Error("Approve the asset before scheduling.");
  const defaultPlatform: "x" | "linkedin" = asset.asset_type === "linkedin_post" ? "linkedin" : "x";
  const requested: Array<"x" | "linkedin"> = [...new Set(platforms?.length ? platforms : [defaultPlatform])];
  for (const platform of requested) {
    if (platform !== "x" && platform !== "linkedin") {
      throw new Error("Only X and LinkedIn can be scheduled today.");
    }
  }
  await ensureBoss();
  const publications: Array<{ id: string; platform: "x" | "linkedin" }> = [];
  for (const platform of requested) {
    const scheduled = await schedulePost(userId, {
      platform,
      content: asset.content,
      scheduledFor: new Date(scheduledFor),
      contentAssetId: assetId,
      workspaceId,
    });
    if (!scheduled.ok || !scheduled.id) throw new Error(scheduled.reason ?? `Could not schedule on ${platform}.`);
    publications.push({ id: scheduled.id, platform });
    await query(
      `INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type)
       VALUES ($1,'asset',$2,'publication',$3,'scheduled_as') ON CONFLICT DO NOTHING`,
      [workspaceId, assetId, scheduled.id],
    );
    await query(
      `INSERT INTO workspace_audit_logs (workspace_id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES ($1,$2,'publication.scheduled','publication',$3,jsonb_build_object('asset_id',$4::text,'scheduled_for',$5::text,'platform',$6::text))`,
      [workspaceId, userId, scheduled.id, assetId, scheduledFor, platform],
    );
  }
  await query(`UPDATE content_assets SET status='scheduled',updated_at=now() WHERE id=$1 AND workspace_id=$2`, [assetId, workspaceId]);
  return publications;
}

/**
 * Seed the minimum Generate prerequisites for Studio: audience, active narrative,
 * and low-risk claim-registry approvals. Returns a clear next step when knowledge
 * is still missing.
 */
export async function ensureStudioReady(userId: string, workspaceId: string): Promise<{
  ready: boolean;
  message?: string;
  href?: string;
}> {
  await requireWorkspaceRole(userId, workspaceId, "editor");

  const audiences = await query<{ id: string }>(
    `SELECT id FROM workspace_audiences WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  );
  if (audiences.length === 0) {
    await createWorkspaceAudience(userId, workspaceId, {
      name: "Primary audience",
      roleType: "champion",
      description: "Default audience for Studio drafts until a richer buyer map is defined.",
    });
  }

  const knowledgeCounts = await queryOne<{ insights: string; claims: string; proofs: string }>(
    `SELECT
       count(*) FILTER (WHERE object_type = 'insight' AND status = 'approved')::text AS insights,
       count(*) FILTER (
         WHERE object_type = 'claim' AND status = 'approved'
           AND EXISTS (
             SELECT 1 FROM claim_registry cr
              WHERE cr.workspace_id = knowledge_objects.workspace_id
                AND cr.knowledge_object_id = knowledge_objects.id
                AND cr.approval_status = 'approved'
           )
       )::text AS claims,
       count(*) FILTER (WHERE object_type = 'proof' AND status = 'approved')::text AS proofs
     FROM knowledge_objects
     WHERE workspace_id = $1
       AND permission_level IN ('public', 'internal')`,
    [workspaceId],
  );
  if (!knowledgeCounts || Number(knowledgeCounts.insights) < 1 || Number(knowledgeCounts.claims) < 1 || Number(knowledgeCounts.proofs) < 1) {
    return {
      ready: false,
      message: "Approve at least one insight, claim, and proof in Knowledge before generating.",
      href: "/app/knowledge",
    };
  }

  const active = await queryOne<{ id: string }>(
    `SELECT id FROM narrative_systems WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  if (!active) {
    return {
      ready: false,
      message: "Activate a narrative in Narrative before generating in Studio.",
      href: "/app/narrative",
    };
  }

  const expert = await resolveDefaultExpert(userId, workspaceId);
  if (!expert) {
    return {
      ready: false,
      message: "Add a default expert voice in workspace settings before drafting.",
      href: "/app/settings",
    };
  }

  return { ready: true };
}

export async function studioGenerate(
  userId: string,
  workspaceId: string,
  input: StudioGenerateInput,
): Promise<{ asset: ContentAssetView; briefId: string }> {
  await requireWorkspaceRole(userId, workspaceId, "editor");
  const readiness = await ensureStudioReady(userId, workspaceId);
  if (!readiness.ready) {
    throw new Error(readiness.message ?? "Studio is not ready yet.");
  }

  // Asset generation cap (atomic count after insert happens in draftFromBrief /
  // atomize via assertGeneratedAssetCap callers). Pre-check here for fast fail.
  const { entitlementsFor, assertWithinCap } = await import("../billing/entitlements.js");
  const entitlements = await entitlementsFor(userId);
  const used = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_assets
      WHERE workspace_id = $1
        AND created_at >= date_trunc('month', now())`,
    [workspaceId],
  );
  assertWithinCap(
    Number(used?.n ?? 0),
    entitlements.generatedAssetsPerMonth,
    "generatedAssetsPerMonth",
    "This workspace has reached its monthly generated-asset limit. Upgrade or wait until next month.",
  );

  const preferred = [...new Set(input.knowledgeObjectIds ?? [])].slice(0, 8);
  const format = input.format && CONTENT_ASSET_TYPES.includes(input.format) ? input.format : "linkedin_post";
  const channel = input.channel ?? (format === "x_post" ? "x" : "linkedin");
  const prompt = [input.userPrompt?.trim(), input.tone ? `Tone: ${input.tone}` : ""].filter(Boolean).join("\n");

  const briefs = await generateBriefOptions(userId, workspaceId, {
    channel,
    count: 1,
    knowledgeObjectIds: preferred,
    userPrompt: prompt || undefined,
    preferredFormat: format,
  });
  const brief = briefs[0];
  if (!brief) throw new Error("Could not generate a brief.");

  // Briefs and assets stay in review until an editor explicitly approves them.
  // Atomization of non-post formats still requires a prior approved parent asset.
  if (format !== "x_post" && format !== "linkedin_post") {
    if (brief.status !== "ready") {
      throw new Error("Approve the generated brief before atomizing into this format.");
    }
    const parent = await draftFromBrief(userId, workspaceId, brief.id);
    if (parent.status !== "approved" && parent.status !== "scheduled" && parent.status !== "published") {
      throw new Error("Approve the LinkedIn/X draft first, then atomize into other formats.");
    }
    const variants = await atomizeContentAsset(userId, workspaceId, parent.id, [format]);
    const variant = variants[0];
    if (!variant) throw new Error(`Could not create a ${format.replaceAll("_", " ")} draft.`);
    return { asset: variant, briefId: brief.id };
  }

  const asset = await draftFromBrief(userId, workspaceId, brief.id);
  return { asset, briefId: brief.id };
}

