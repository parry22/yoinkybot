import { z } from "zod";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { narrativeBuilder } from "../prompts/narrative-builder.v1.js";
import { requireWorkspaceRole } from "../workspaces/service.js";
import type { BuyerJourneyQuestionView, ClaimRegistryView, EditorialTerritoryView, NarrativeArchitectureView, NarrativeFields, NarrativeMessageView, NarrativeSystemView, WorkspaceAudienceView } from "./types.js";

const proposalSchema = z.object({
  category_thesis: z.string().min(10).max(1000),
  problem_narrative: z.string().min(10).max(1500),
  point_of_view: z.string().min(10).max(1000),
  unique_mechanism: z.string().min(10).max(1000),
  primary_promise: z.string().min(10).max(1000),
  territories: z.array(z.object({
    name: z.string().min(2).max(120),
    audience_problem: z.string().max(700).catch(""),
    company_perspective: z.string().max(700).catch(""),
    commercial_relevance: z.string().max(700).catch(""),
    proof_requirements: z.string().max(700).catch(""),
    recurring_formats: z.array(z.string().max(100)).max(8).catch([]),
    topics_to_avoid: z.array(z.string().max(100)).max(8).catch([]),
  })).min(1).max(6),
});

interface NarrativeRow {
  id: string;
  workspace_id: string;
  version: number;
  status: NarrativeSystemView["status"];
  category_thesis: string;
  problem_narrative: string;
  point_of_view: string;
  unique_mechanism: string;
  primary_promise: string;
  approved_at: string | null;
}

interface TerritoryRow {
  id: string;
  name: string;
  audience_problem: string | null;
  company_perspective: string | null;
  commercial_relevance: string | null;
  proof_requirements: string | null;
  recurring_formats: string[];
  topics_to_avoid: string[];
  status: EditorialTerritoryView["status"];
}

async function hydrate(row: NarrativeRow): Promise<NarrativeSystemView> {
  const territories = await query<TerritoryRow>(
    `SELECT id, name, audience_problem, company_perspective, commercial_relevance,
            proof_requirements, recurring_formats, topics_to_avoid, status
       FROM editorial_territories WHERE narrative_system_id = $1 ORDER BY created_at`,
    [row.id],
  );
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    status: row.status,
    categoryThesis: row.category_thesis,
    problemNarrative: row.problem_narrative,
    pointOfView: row.point_of_view,
    uniqueMechanism: row.unique_mechanism,
    primaryPromise: row.primary_promise,
    approvedAt: row.approved_at,
    territories: territories.map((territory) => ({
      id: territory.id,
      name: territory.name,
      audienceProblem: territory.audience_problem,
      companyPerspective: territory.company_perspective,
      commercialRelevance: territory.commercial_relevance,
      proofRequirements: territory.proof_requirements,
      recurringFormats: territory.recurring_formats,
      topicsToAvoid: territory.topics_to_avoid,
      status: territory.status,
    })),
  };
}

export async function listNarrativeSystems(userId: string, workspaceId: string): Promise<NarrativeSystemView[]> {
  await requireWorkspaceRole(userId, workspaceId, "viewer");
  const rows = await query<NarrativeRow>(
    `SELECT id, workspace_id, version, status, category_thesis, problem_narrative,
            point_of_view, unique_mechanism, primary_promise, approved_at::text
       FROM narrative_systems WHERE workspace_id = $1
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, version DESC`,
    [workspaceId],
  );
  return Promise.all(rows.map(hydrate));
}

export async function generateNarrativeProposal(userId: string, workspaceId: string): Promise<NarrativeSystemView> {
  const workspace = await requireWorkspaceRole(userId, workspaceId, "strategist");
  const knowledge = await query<{ object_type: string; title: string; body: string }>(
    `SELECT object_type, title, body FROM knowledge_objects
      WHERE workspace_id = $1 AND status = 'approved'
        AND permission_level IN ('public','internal')
      ORDER BY confidence DESC, created_at DESC LIMIT 40`,
    [workspaceId],
  );
  if (knowledge.length === 0) throw new Error("Approve at least one knowledge object before building a narrative.");
  const response = await llmCall({
    userId,
    eventType: "narrative_build",
    tier: narrativeBuilder.tier,
    system: narrativeBuilder.system,
    user: narrativeBuilder.render({
      workspace: `${workspace.name}. ${workspace.description ?? ""}`,
      objective: workspace.primaryObjective ?? "Build a trusted company narrative.",
      knowledge: knowledge.map((item) => ({ type: item.object_type, title: item.title, body: item.body })),
    }),
    json: true,
    maxTokens: 3000,
  });
  const proposal = proposalSchema.parse(response.parsed);

  const id = await withTransaction(async (client) => {
    const version = await client.query<{ next: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS next FROM narrative_systems WHERE workspace_id = $1`,
      [workspaceId],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO narrative_systems
         (workspace_id, version, status, category_thesis, problem_narrative, point_of_view,
          unique_mechanism, primary_promise, created_by_user_id)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [workspaceId, version.rows[0]?.next ?? 1, proposal.category_thesis, proposal.problem_narrative,
       proposal.point_of_view, proposal.unique_mechanism, proposal.primary_promise, userId],
    );
    const narrativeId = created.rows[0]?.id;
    if (!narrativeId) throw new Error("Could not save narrative proposal.");
    for (const territory of proposal.territories) {
      await client.query(
        `INSERT INTO editorial_territories
           (workspace_id, narrative_system_id, name, audience_problem, company_perspective,
            commercial_relevance, proof_requirements, recurring_formats, topics_to_avoid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
        [workspaceId, narrativeId, territory.name, territory.audience_problem || null,
         territory.company_perspective || null, territory.commercial_relevance || null,
         territory.proof_requirements || null, JSON.stringify(territory.recurring_formats), JSON.stringify(territory.topics_to_avoid)],
      );
    }
    await client.query(
      `INSERT INTO narrative_messages
         (narrative_system_id,message_type,problem,new_insight,mechanism,evidence_summary,desired_action,status)
       VALUES ($1,'company',$2,$3,$4,$5,$6,'draft')`,
      [narrativeId,proposal.problem_narrative,proposal.point_of_view,proposal.unique_mechanism,
       "Use approved claims and proof from the workspace registry.",proposal.primary_promise],
    );
    for (const object of knowledge) {
      const objectRow = await client.query<{ id:string }>(
        `SELECT id FROM knowledge_objects WHERE workspace_id=$1 AND title=$2 AND body=$3 LIMIT 1`,
        [workspaceId, object.title, object.body],
      );
      if (objectRow.rows[0]) await client.query(
        `INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type)
         VALUES ($1,'knowledge_object',$2,'narrative',$3,'informed') ON CONFLICT DO NOTHING`,
        [workspaceId, objectRow.rows[0].id, narrativeId],
      );
    }
    return narrativeId;
  });
  const row = await queryOne<NarrativeRow>(
    `SELECT id, workspace_id, version, status, category_thesis, problem_narrative,
            point_of_view, unique_mechanism, primary_promise, approved_at::text
       FROM narrative_systems WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  if (!row) throw new Error("Could not reload narrative proposal.");
  return hydrate(row);
}

export async function updateNarrativeDraft(
  userId: string,
  workspaceId: string,
  narrativeId: string,
  fields: NarrativeFields,
  activate: boolean,
): Promise<NarrativeSystemView> {
  await requireWorkspaceRole(userId, workspaceId, "strategist");
  const clean = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim().slice(0, 1500)])) as unknown as NarrativeFields;
  if (Object.values(clean).some((value) => value.length < 10)) throw new Error("Complete every narrative field before saving.");
  await withTransaction(async (client) => {
    const target = await client.query<{ status: string }>(
      `SELECT status FROM narrative_systems WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [narrativeId, workspaceId],
    );
    if (!target.rows[0] || target.rows[0].status !== "draft") throw new Error("Only a draft narrative can be edited.");
    await client.query(
      `UPDATE narrative_systems SET category_thesis=$3, problem_narrative=$4, point_of_view=$5,
              unique_mechanism=$6, primary_promise=$7, updated_at=now()
        WHERE id=$1 AND workspace_id=$2`,
      [narrativeId, workspaceId, clean.categoryThesis, clean.problemNarrative, clean.pointOfView,
       clean.uniqueMechanism, clean.primaryPromise],
    );
    if (activate) {
      await client.query(`UPDATE narrative_systems SET status='superseded', updated_at=now() WHERE workspace_id=$1 AND status='active'`, [workspaceId]);
      await client.query(
        `UPDATE narrative_systems SET status='active', approved_by_user_id=$3, approved_at=now(), updated_at=now()
          WHERE id=$1 AND workspace_id=$2`,
        [narrativeId, workspaceId, userId],
      );
      await client.query(`UPDATE editorial_territories SET status='active', updated_at=now() WHERE narrative_system_id=$1`, [narrativeId]);
      await client.query(`UPDATE narrative_messages SET status='active',updated_at=now() WHERE narrative_system_id=$1`,[narrativeId]);
      await client.query(
        `INSERT INTO workspace_audit_logs (workspace_id,actor_user_id,action,entity_type,entity_id)
         VALUES ($1,$2,'narrative.activated','narrative_system',$3)`,
        [workspaceId,userId,narrativeId],
      );
    }
  });
  const systems = await listNarrativeSystems(userId, workspaceId);
  const updated = systems.find((system) => system.id === narrativeId);
  if (!updated) throw new Error("Narrative could not be reloaded.");
  return updated;
}

export async function getNarrativeArchitecture(userId:string,workspaceId:string):Promise<NarrativeArchitectureView>{
  await requireWorkspaceRole(userId,workspaceId,"viewer");
  const [audiences,questions,messages,claims]=await Promise.all([
    query<{id:string;name:string;role_type:string;description:string|null;needs:string[];objections:string[];success_definition:string|null}>(`SELECT id,name,role_type,description,needs,objections,success_definition FROM workspace_audiences WHERE workspace_id=$1 ORDER BY created_at`,[workspaceId]),
    query<{id:string;audience_id:string|null;audience_name:string|null;stage:string;question:string;priority:number;status:BuyerJourneyQuestionView["status"]}>(`SELECT bjq.id,bjq.audience_id,wa.name audience_name,bjq.stage,bjq.question,bjq.priority,bjq.status FROM buyer_journey_questions bjq LEFT JOIN workspace_audiences wa ON wa.id=bjq.audience_id AND wa.workspace_id=bjq.workspace_id WHERE bjq.workspace_id=$1 ORDER BY bjq.priority DESC,bjq.created_at`,[workspaceId]),
    query<{id:string;narrative_system_id:string;message_type:string;audience_name:string|null;problem:string|null;new_insight:string|null;mechanism:string|null;evidence_summary:string|null;desired_action:string|null;status:NarrativeMessageView["status"]}>(`SELECT nm.id,nm.narrative_system_id,nm.message_type,wa.name audience_name,nm.problem,nm.new_insight,nm.mechanism,nm.evidence_summary,nm.desired_action,nm.status FROM narrative_messages nm JOIN narrative_systems ns ON ns.id=nm.narrative_system_id LEFT JOIN workspace_audiences wa ON wa.id=nm.audience_id AND wa.workspace_id=ns.workspace_id WHERE ns.workspace_id=$1 ORDER BY nm.created_at`,[workspaceId]),
    query<{id:string;knowledge_object_id:string;claim_text:string;risk_level:ClaimRegistryView["riskLevel"];approval_status:ClaimRegistryView["approvalStatus"];evidence_requirements:string|null;evidence_object_ids:string[];allowed_contexts:string[];prohibited_contexts:string[];approved_at:string|null;expires_at:string|null}>(`SELECT id,knowledge_object_id,claim_text,risk_level,approval_status,evidence_requirements,evidence_object_ids,allowed_contexts,prohibited_contexts,approved_at::text,expires_at::text FROM claim_registry WHERE workspace_id=$1 ORDER BY CASE approval_status WHEN 'pending' THEN 0 WHEN 'prohibited' THEN 1 ELSE 2 END,created_at DESC`,[workspaceId]),
  ]);
  return {
    audiences:audiences.map((row):WorkspaceAudienceView=>({id:row.id,name:row.name,roleType:row.role_type,description:row.description,needs:row.needs,objections:row.objections,successDefinition:row.success_definition})),
    journeyQuestions:questions.map(row=>({id:row.id,audienceId:row.audience_id,audienceName:row.audience_name,stage:row.stage,question:row.question,priority:Number(row.priority),status:row.status})),
    messages:messages.map(row=>({id:row.id,narrativeSystemId:row.narrative_system_id,messageType:row.message_type,audienceName:row.audience_name,problem:row.problem,newInsight:row.new_insight,mechanism:row.mechanism,evidenceSummary:row.evidence_summary,desiredAction:row.desired_action,status:row.status})),
    claims:claims.map(row=>({id:row.id,knowledgeObjectId:row.knowledge_object_id,claimText:row.claim_text,riskLevel:row.risk_level,approvalStatus:row.approval_status,evidenceRequirements:row.evidence_requirements,evidenceObjectIds:row.evidence_object_ids,allowedContexts:row.allowed_contexts,prohibitedContexts:row.prohibited_contexts,approvedAt:row.approved_at,expiresAt:row.expires_at})),
  };
}

export async function createWorkspaceAudience(userId:string,workspaceId:string,input:{name:string;roleType:string;description?:string;needs?:string[];objections?:string[];successDefinition?:string}):Promise<WorkspaceAudienceView>{
  await requireWorkspaceRole(userId,workspaceId,"strategist");
  const allowed=["end_user","champion","technical_evaluator","budget_owner","executive_approver","influencer","other"];
  if(!allowed.includes(input.roleType))throw new Error("Invalid audience role.");
  const row=await queryOne<{id:string}>(`INSERT INTO workspace_audiences (workspace_id,name,role_type,description,needs,objections,success_definition) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id`,[workspaceId,input.name.trim().slice(0,120),input.roleType,input.description?.trim().slice(0,1000)||null,JSON.stringify(input.needs?.slice(0,12)??[]),JSON.stringify(input.objections?.slice(0,12)??[]),input.successDefinition?.trim().slice(0,600)||null]);
  if(!row)throw new Error("Could not save audience.");
  return (await getNarrativeArchitecture(userId,workspaceId)).audiences.find(item=>item.id===row.id)!;
}

export async function createBuyerJourneyQuestion(userId:string,workspaceId:string,input:{audienceId?:string|null;stage:string;question:string;priority?:number}):Promise<BuyerJourneyQuestionView>{
  await requireWorkspaceRole(userId,workspaceId,"strategist");
  const stages=["problem_unaware","problem_aware","solution_aware","product_aware","evaluation","purchase","adoption","advocacy"];
  if(!stages.includes(input.stage))throw new Error("Invalid buyer journey stage.");
  if(input.audienceId){const audience=await queryOne(`SELECT 1 FROM workspace_audiences WHERE id=$1 AND workspace_id=$2`,[input.audienceId,workspaceId]);if(!audience)throw new Error("Audience not found in this workspace.");}
  const row=await queryOne<{id:string}>(`INSERT INTO buyer_journey_questions (workspace_id,audience_id,stage,question,priority) VALUES ($1,$2,$3,$4,$5) RETURNING id`,[workspaceId,input.audienceId??null,input.stage,input.question.trim().slice(0,1000),Math.max(0,Math.min(100,input.priority??50))]);
  if(!row)throw new Error("Could not save buyer question.");
  return (await getNarrativeArchitecture(userId,workspaceId)).journeyQuestions.find(item=>item.id===row.id)!;
}

export async function reviewRegisteredClaim(userId:string,workspaceId:string,claimId:string,input:{decision:"approved"|"rejected"|"prohibited";riskLevel:"low"|"medium"|"high"|"regulated";evidenceRequirements?:string|null;evidenceObjectIds?:string[];allowedContexts?:string[];prohibitedContexts?:string[];expiresAt?:string|null}):Promise<ClaimRegistryView>{
  const requiredRole=input.riskLevel==="high"||input.riskLevel==="regulated"?"admin":"editor";
  await requireWorkspaceRole(userId,workspaceId,requiredRole);
  const evidenceIds=[...new Set(input.evidenceObjectIds??[])].slice(0,20);
  if(input.decision==="approved"&&(input.riskLevel==="high"||input.riskLevel==="regulated")){
    if(!input.evidenceRequirements?.trim()||evidenceIds.length===0)throw new Error("High-risk and regulated claims require explicit evidence and review requirements.");
  }
  if(evidenceIds.length){const valid=await query<{id:string}>(`SELECT id FROM knowledge_objects WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND object_type='proof' AND status='approved' AND permission_level IN ('public','internal')`,[workspaceId,evidenceIds]);if(valid.length!==evidenceIds.length)throw new Error("Every evidence item must be approved proof from this workspace.");}
  const row=await queryOne<{id:string}>(`UPDATE claim_registry SET risk_level=$3,approval_status=$4,evidence_requirements=$5,evidence_object_ids=$6::jsonb,allowed_contexts=$7::jsonb,prohibited_contexts=$8::jsonb,approved_by_user_id=CASE WHEN $4='approved' THEN $1 ELSE NULL END,approved_at=CASE WHEN $4='approved' THEN now() ELSE NULL END,expires_at=$9::timestamptz,updated_at=now() WHERE id=$2 AND workspace_id=$10 RETURNING id`,[userId,claimId,input.riskLevel,input.decision,input.evidenceRequirements?.trim().slice(0,1000)||null,JSON.stringify(evidenceIds),JSON.stringify(input.allowedContexts?.slice(0,20)??[]),JSON.stringify(input.prohibitedContexts?.slice(0,20)??[]),input.expiresAt||null,workspaceId]);
  if(!row)throw new Error("Claim not found in this workspace.");
  await query(`INSERT INTO workspace_audit_logs (workspace_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES ($1,$2,$3,'claim',$4,jsonb_build_object('risk_level',$5::text))`,[workspaceId,userId,`claim.${input.decision}`,claimId,input.riskLevel]);
  return (await getNarrativeArchitecture(userId,workspaceId)).claims.find(item=>item.id===claimId)!;
}
