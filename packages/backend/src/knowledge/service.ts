import { createHash } from "node:crypto";
import { z } from "zod";
import { query, queryOne, toVector, withTransaction } from "../db/pool.js";
import { embed } from "../llm/embeddings.js";
import { llmCall } from "../llm/gateway.js";
import { knowledgeExtract } from "../prompts/knowledge-extract.v1.js";
import { ensureBoss, getBoss, QUEUES } from "../jobs/boss.js";
import { requireWorkspaceRole, resolveDefaultExpert } from "../workspaces/service.js";
import {
  KNOWLEDGE_OBJECT_TYPES,
  PERMISSION_LEVELS,
  type KnowledgeObjectType,
  type KnowledgeObjectView,
  type KnowledgeStatus,
  type PermissionLevel,
  type TranscriptInput,
  WORKSPACE_SOURCE_TYPES,
} from "./types.js";

const RELATIONSHIP_TYPES = [
  "supports", "contradicts", "extends", "illustrates", "answers", "evidences", "derived_from", "related_to", "used_in",
] as const;

const extractedSchema = z.object({
  objects: z.array(z.object({
    temp_id: z.string().min(1).max(30),
    object_type: z.enum(KNOWLEDGE_OBJECT_TYPES),
    title: z.string().min(1).max(180),
    body: z.string().min(1).max(5000),
    confidence: z.number().min(0).max(1).catch(0.5),
    audience_hint: z.string().max(300).catch(""),
    problem_hint: z.string().max(300).catch(""),
    buying_stage_hint: z.string().max(100).catch(""),
    commercial_relevance: z.string().max(500).catch(""),
    expiry_hint: z.string().nullable().catch(null),
  })).max(30),
  relationships: z.array(z.object({
    from_temp_id: z.string(),
    to_temp_id: z.string(),
    relationship_type: z.enum(RELATIONSHIP_TYPES),
    confidence: z.number().min(0).max(1).catch(0.5),
  })).max(60).catch([]),
});

interface KnowledgeRow {
  id: string;
  workspace_id: string;
  object_type: KnowledgeObjectType;
  title: string;
  body: string;
  status: KnowledgeStatus;
  confidence: number;
  permission_level: PermissionLevel;
  source_capture_id: string;
  source_id: string;
  source_name: string;
  speaker_name: string | null;
  speaker_expert_id: string | null;
  audience_ids: string[];
  territory_ids: string[];
  buying_stage: string | null;
  commercial_relevance: string | null;
  created_at: string;
}

function mapRow(row: KnowledgeRow): KnowledgeObjectView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    objectType: row.object_type,
    title: row.title,
    body: row.body,
    status: row.status,
    confidence: Number(row.confidence),
    permissionLevel: row.permission_level,
    sourceCaptureId: row.source_capture_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    speakerName: row.speaker_name,
    speakerExpertId: row.speaker_expert_id,
    audienceIds: row.audience_ids,
    territoryIds: row.territory_ids,
    buyingStage: row.buying_stage,
    commercialRelevance: row.commercial_relevance,
    createdAt: row.created_at,
  };
}

function normalizedHash(body: string): string {
  const normalized = body.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function canPermissionEnterGeneration(permission:PermissionLevel):boolean{return permission==="public"||permission==="internal";}

export async function listKnowledgeObjects(userId: string, workspaceId: string): Promise<KnowledgeObjectView[]> {
  const context=await requireWorkspaceRole(userId, workspaceId, "viewer");
  const rows = await query<KnowledgeRow>(
    `SELECT ko.id, ko.workspace_id, ko.object_type, ko.title, ko.body, ko.status,
            ko.confidence, ko.permission_level, ko.source_capture_id,
            ws.id AS source_id, ws.name AS source_name, e.name AS speaker_name,
            ko.speaker_expert_id,
            ARRAY(SELECT DISTINCT audience_id FROM (
              SELECT value::uuid AS audience_id FROM jsonb_array_elements_text(ko.audience_ids) AS value
              UNION ALL
              SELECT cb.audience_id FROM content_brief_sources cbs JOIN content_briefs cb ON cb.id=cbs.content_brief_id AND cb.workspace_id=ko.workspace_id WHERE cbs.knowledge_object_id=ko.id
            ) audiences WHERE audience_id IS NOT NULL) audience_ids,
            ARRAY(SELECT DISTINCT cb.territory_id FROM content_brief_sources cbs JOIN content_briefs cb ON cb.id=cbs.content_brief_id AND cb.workspace_id=ko.workspace_id WHERE cbs.knowledge_object_id=ko.id AND cb.territory_id IS NOT NULL) territory_ids,
            ko.buying_stage, ko.commercial_relevance,
            ko.created_at::text
       FROM knowledge_objects ko
       JOIN captures c ON c.id = ko.source_capture_id AND c.workspace_id = ko.workspace_id
       JOIN workspace_sources ws ON ws.id = c.source_id AND ws.workspace_id = ko.workspace_id
       LEFT JOIN experts e ON e.id = ko.speaker_expert_id AND e.workspace_id = ko.workspace_id
      WHERE ko.workspace_id = $1
        AND (ko.permission_level IN ('public','internal')
          OR (ko.permission_level='restricted' AND $2::text IN ('owner','admin','strategist','editor'))
          OR (ko.permission_level IN ('confidential','never_use_for_generation') AND $2::text IN ('owner','admin')))
      ORDER BY CASE ko.status WHEN 'proposed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
               ko.created_at DESC`,
    [workspaceId,context.role],
  );
  return rows.map(mapRow);
}

export async function extractTranscriptToKnowledge(
  userId: string,
  workspaceId: string,
  input: TranscriptInput,
): Promise<KnowledgeObjectView[]> {
  const context = await requireWorkspaceRole(userId, workspaceId, "contributor");
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 180);
  const transcript = input.transcript.trim();
  if (title.length < 2) throw new Error("Give this transcript a title.");
  if (transcript.length < 80) throw new Error("The transcript is too short to extract useful company knowledge.");
  if (transcript.length > 100_000) throw new Error("This transcript is too long. Split it into sections under 100,000 characters.");
  const permissionLevel = input.permissionLevel ?? "internal";
  if (!PERMISSION_LEVELS.includes(permissionLevel)) throw new Error("Invalid permission level.");
  const sourceType = input.sourceType ?? "founder_interview";
  if (!WORKSPACE_SOURCE_TYPES.includes(sourceType)) throw new Error("Invalid source type.");

  const defaultExpert = await resolveDefaultExpert(userId, workspaceId);
  const speakerId = input.speakerExpertId ?? defaultExpert?.id ?? null;
  if (speakerId) {
    const validExpert = await queryOne<{ id: string }>(`SELECT id FROM experts WHERE id = $1 AND workspace_id = $2`, [speakerId, workspaceId]);
    if (!validExpert) throw new Error("The selected expert does not belong to this workspace.");
  }
  const speakerName = speakerId
    ? (await queryOne<{ name: string }>(`SELECT name FROM experts WHERE id = $1 AND workspace_id = $2`, [speakerId, workspaceId]))?.name
    : null;

  const captureSource = sourceType === "x_history" ? "x_import" : sourceType === "linkedin_history" ? "linkedin_import" : sourceType;
  const stored = input.existingCaptureId ? await withTransaction(async client=>{
    const existing=await client.query<{id:string;source_id:string|null}>(`SELECT id,source_id FROM captures WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,[input.existingCaptureId,workspaceId,userId]);
    const capture=existing.rows[0];if(!capture)throw new Error("Capture not found in this workspace.");
    let sourceId=capture.source_id;if(!sourceId){const source=await client.query<{id:string}>(`INSERT INTO workspace_sources (workspace_id,source_type,name,owner_expert_id,permission_level) VALUES ($1,$2,$3,$4,$5) RETURNING id`,[workspaceId,sourceType,title,speakerId,permissionLevel]);sourceId=source.rows[0]?.id??null;if(!sourceId)throw new Error("Could not store capture source.");await client.query(`UPDATE captures SET source_id=$2 WHERE id=$1`,[capture.id,sourceId]);}
    return {sourceId,captureId:capture.id};
  }) : await withTransaction(async (client) => {
    const source = await client.query<{ id: string }>(
      `INSERT INTO workspace_sources
         (workspace_id, source_type, name, owner_expert_id, permission_level, extraction_policy)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $5='never_use_for_generation' THEN '{"disabled":true}'::jsonb ELSE '{}'::jsonb END)
       RETURNING id`,
      [workspaceId, sourceType, title, speakerId, permissionLevel],
    );
    const sourceId = source.rows[0]?.id;
    if (!sourceId) throw new Error("Could not store transcript source.");
    const capture = await client.query<{ id: string }>(
      `INSERT INTO captures
         (user_id, source, raw_text, status, workspace_id, source_id, speaker_expert_id, permission_level, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               jsonb_build_object('title', $9::text, 'knowledge_prompt', 'knowledge-extract.v1'))
       RETURNING id`,
      [userId, captureSource, transcript, permissionLevel === "never_use_for_generation" ? "processed" : "extracting",
       workspaceId, sourceId, speakerId, permissionLevel, title],
    );
    const captureId = capture.rows[0]?.id;
    if (!captureId) throw new Error("Could not store transcript capture.");
    return { sourceId, captureId };
  });

  // Never-use sources are retained for governance and export, but no model sees
  // their contents and no object is created from them.
  if (permissionLevel === "never_use_for_generation") return [];

  // Existing personal-workspace memory behaviour remains intact. Company
  // sources do not enter the user's personal memory graph because that graph is
  // user-owned and has no tenant boundary; company knowledge is stored below in
  // the workspace-owned domain instead.
  if (context.workspaceType === "personal"&&!input.existingCaptureId) {
    await ensureBoss();
    await getBoss().send(QUEUES.extract, { captureId: stored.captureId, userId });
  }

  const activeNarrative = await queryOne<{ summary: string }>(
    `SELECT concat_ws(E'\n',category_thesis,problem_narrative,point_of_view,unique_mechanism,primary_promise) AS summary
       FROM narrative_systems WHERE workspace_id=$1 AND status='active'`,
    [workspaceId],
  );

  let extracted:z.infer<typeof extractedSchema>;
  try {
    const response = await llmCall({
      userId,
      eventType: "knowledge_extract",
      tier: knowledgeExtract.tier,
      system: knowledgeExtract.system,
      user: knowledgeExtract.render({
        sourceType,
        sourceTitle: title,
        sourceContent: transcript.slice(0, 100_000),
        speaker: speakerName ?? "Unknown speaker",
        workspaceSummary: `${context.name}. ${context.description ?? ""} Objective: ${context.primaryObjective ?? "Not set"}`,
        activeNarrativeSummary: activeNarrative?.summary ?? null,
        allowedObjectTypes: [...KNOWLEDGE_OBJECT_TYPES],
        permissionLevel,
      }),
      json: true,
      maxTokens: 4096,
    });
    extracted = extractedSchema.parse(response.parsed);
    if (extracted.objects.length === 0) throw new Error("No useful knowledge was found in this transcript.");
  } catch (error) {
    await withTransaction(async client=>{
      await client.query(`UPDATE captures SET status='failed',metadata=metadata||jsonb_build_object('knowledge_extraction_failed_at',now()) WHERE id=$1 AND workspace_id=$2`,[stored.captureId,workspaceId]);
      await client.query(`UPDATE workspace_sources SET status='failed',updated_at=now() WHERE id=$1 AND workspace_id=$2`,[stored.sourceId,workspaceId]);
    });
    throw error;
  }

  // Embeddings improve deduplication, but a provider outage must not discard a
  // valid extraction. Exact normalized hashes remain the deterministic floor.
  const embeddings = await embed(extracted.objects.map((object) => object.body), userId).catch(() => [] as number[][]);

  const createdIds = await withTransaction(async (client) => {
    const tempToId = new Map<string, string>();
    const ids: string[] = [];
    for (let index = 0; index < extracted.objects.length; index++) {
      const object = extracted.objects[index]!;
      const vector = embeddings[index];
      if (vector) {
        const near = await client.query<{ id: string }>(
          `SELECT id FROM knowledge_objects
            WHERE workspace_id = $1 AND object_type = $2 AND embedding IS NOT NULL
              AND (embedding <=> $3::vector) < 0.08
            LIMIT 1`,
          [workspaceId, object.object_type, toVector(vector)],
        );
        if (near.rows[0]) continue;
      }
      const row = await client.query<{ id: string }>(
        `INSERT INTO knowledge_objects
           (workspace_id, object_type, title, body, content_hash, source_capture_id,
            speaker_expert_id, status, confidence, permission_level, buying_stage,
            commercial_relevance, expiry_at, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8, $9, $10, $11,
                 CASE WHEN $12::text IS NULL OR $12::text = '' THEN NULL ELSE $12::timestamptz END,
                 $13::vector, $14::jsonb)
         ON CONFLICT (workspace_id, content_hash, object_type) DO NOTHING
         RETURNING id`,
        [
          workspaceId, object.object_type, object.title.trim(), object.body.trim(), normalizedHash(object.body),
          stored.captureId, speakerId, object.confidence, permissionLevel, object.buying_stage_hint || null,
          object.commercial_relevance || null, object.expiry_hint, vector ? toVector(vector) : null,
          JSON.stringify({ audience_hint: object.audience_hint, problem_hint: object.problem_hint, prompt: "knowledge-extract.v1" }),
        ],
      );
      const id = row.rows[0]?.id;
      if (id) {
        tempToId.set(object.temp_id, id);
        ids.push(id);
      }
    }

    for (const relationship of extracted.relationships) {
      const fromId = tempToId.get(relationship.from_temp_id);
      const toId = tempToId.get(relationship.to_temp_id);
      if (!fromId || !toId || fromId === toId) continue;
      await client.query(
        `INSERT INTO knowledge_relationships
           (workspace_id, from_object_id, to_object_id, relationship_type, confidence, created_by)
         VALUES ($1, $2, $3, $4, $5, 'model') ON CONFLICT DO NOTHING`,
        [workspaceId, fromId, toId, relationship.relationship_type, relationship.confidence],
      );
    }
    for (const id of ids) {
      await client.query(
        `INSERT INTO content_lineage (workspace_id,source_type,source_id,target_type,target_id,relationship_type)
         VALUES ($1,'capture',$2,'knowledge_object',$3,'extracted_from') ON CONFLICT DO NOTHING`,
        [workspaceId, stored.captureId, id],
      );
    }
    await client.query(`UPDATE workspace_sources SET last_ingested_at=now(),updated_at=now() WHERE id=$1 AND workspace_id=$2`, [stored.sourceId, workspaceId]);
    if (context.workspaceType === "company") {
      await client.query(`UPDATE captures SET status='processed' WHERE id=$1 AND workspace_id=$2`, [stored.captureId, workspaceId]);
    }
    if (speakerId) {
      const version = await client.query<{ next: number }>(
        `SELECT COALESCE(max(version),0)+1 AS next FROM expert_voice_profiles WHERE expert_id=$1`,
        [speakerId],
      );
      await client.query(
        `INSERT INTO expert_voice_profiles
           (workspace_id,expert_id,version,traits,evidence_capture_ids,created_by_user_id)
         VALUES ($1,$2,$3,jsonb_build_object(
           'guidance','Preserve this expert''s exact phrasing, qualifications and level of certainty from approved evidence.',
           'source_title',$4::text),jsonb_build_array($5::text),$6)`,
        [workspaceId, speakerId, version.rows[0]?.next ?? 1, title, stored.captureId, userId],
      );
    }
    return ids;
  });

  if (createdIds.length === 0) return [];
  const all = await listKnowledgeObjects(userId, workspaceId);
  return all.filter((object) => createdIds.includes(object.id));
}

export async function reviewKnowledgeObject(
  userId: string,
  workspaceId: string,
  objectId: string,
  status: Exclude<KnowledgeStatus, "proposed">,
): Promise<KnowledgeObjectView> {
  await requireWorkspaceRole(userId, workspaceId, "editor");
  const permission=await queryOne<{permission_level:string}>(`SELECT permission_level FROM knowledge_objects WHERE id=$1 AND workspace_id=$2`,[objectId,workspaceId]);
  if(permission?.permission_level==="confidential"||permission?.permission_level==="never_use_for_generation")await requireWorkspaceRole(userId,workspaceId,"admin");
  if (!["reviewed", "approved", "rejected", "archived"].includes(status)) throw new Error("Invalid review action.");
  const row = await queryOne<{ id: string }>(
    `UPDATE knowledge_objects
        SET status = $4, updated_at = now(),
            metadata = metadata || jsonb_build_object('last_reviewed_by', $1::text, 'last_reviewed_at', now())
      WHERE id = $2 AND workspace_id = $3
      RETURNING id`,
    [userId, objectId, workspaceId, status],
  );
  if (!row) throw new Error("Knowledge object not found in this workspace.");
  if (status === "approved") {
    // Knowledge approval makes a claim eligible for the registry, but does not
    // approve the public claim itself. That remains a second explicit action.
    await query(
      `INSERT INTO claim_registry (workspace_id, knowledge_object_id, claim_text, approval_status)
       SELECT workspace_id, id, body, 'pending' FROM knowledge_objects
        WHERE id = $1 AND workspace_id = $2 AND object_type = 'claim'
       ON CONFLICT (workspace_id, knowledge_object_id) DO NOTHING`,
      [objectId, workspaceId],
    );
  }
  const all = await listKnowledgeObjects(userId, workspaceId);
  const updated = all.find((object) => object.id === objectId);
  if (!updated) throw new Error("Knowledge object could not be reloaded.");
  return updated;
}
