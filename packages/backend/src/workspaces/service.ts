import type { PoolClient } from "pg";
import { entitlementsFor, assertWithinCap } from "../billing/entitlements.js";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { assertWorkspaceRole, WorkspaceAccessError } from "./permissions.js";
import type {
  CreateCompanyWorkspaceInput,
  ExpertView,
  WorkspaceContext,
  WorkspaceRole,
  WorkspaceSummary,
  WorkspaceAdminView,
  WorkspaceMemberView,
  WorkspaceSourceView,
  ExpertType,
  WorkspaceHomeView,
} from "./types.js";

interface WorkspaceRow {
  id: string;
  organization_id: string;
  organization_name: string;
  name: string;
  slug: string;
  workspace_type: "personal" | "company";
  description: string | null;
  primary_objective: string | null;
  primary_objective_key: string | null;
  industry: string | null;
  website: string | null;
  role: WorkspaceRole;
  active: boolean;
  default_expert_id: string | null;
  default_expert_name: string | null;
}

interface ExpertRow {
  id: string;
  workspace_id: string;
  linked_user_id: string | null;
  name: string;
  title: string | null;
  expert_type: ExpertView["expertType"];
  bio: string | null;
  is_default: boolean;
  is_public_voice: boolean;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54) || "workspace";
}

function displayName(email: string | null): string {
  if (!email) return "My voice";
  const local = email.split("@")[0] ?? "My voice";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "My voice";
}

function mapWorkspace(row: WorkspaceRow): WorkspaceSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    slug: row.slug,
    workspaceType: row.workspace_type,
    description: row.description,
    primaryObjective: row.primary_objective,
    primaryObjectiveKey: row.primary_objective_key,
    industry: row.industry,
    website: row.website,
    role: row.role,
    active: row.active,
    defaultExpertId: row.default_expert_id,
    defaultExpertName: row.default_expert_name,
  };
}

function mapExpert(row: ExpertRow): ExpertView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    linkedUserId: row.linked_user_id,
    name: row.name,
    title: row.title,
    expertType: row.expert_type,
    bio: row.bio,
    isDefault: row.is_default,
    isPublicVoice: row.is_public_voice,
  };
}

async function uniqueSlug(client: PoolClient, table: "organizations" | "workspaces", base: string, organizationId?: string) {
  const root = slugify(base);
  for (let suffix = 0; suffix < 100; suffix++) {
    const candidate = suffix === 0 ? root : `${root}-${suffix + 1}`;
    const found = organizationId
      ? await client.query(`SELECT 1 FROM ${table} WHERE organization_id = $1 AND slug = $2`, [organizationId, candidate])
      : await client.query(`SELECT 1 FROM ${table} WHERE slug = $1`, [candidate]);
    if (found.rowCount === 0) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** Idempotently creates the private organization, workspace and founder expert. */
export async function ensurePersonalWorkspace(userId: string): Promise<WorkspaceSummary> {
  await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`personal-workspace:${userId}`]);
    const user = await client.query<{ email: string | null; active_workspace_id: string | null }>(
      `SELECT email, active_workspace_id FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!user.rows[0]) throw new WorkspaceAccessError("User not found.");

    const existing = await client.query<{ id: string }>(
      `SELECT w.id
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = $1 AND w.workspace_type = 'personal'
        LIMIT 1`,
      [userId],
    );
    let workspaceId = existing.rows[0]?.id;

    if (!workspaceId) {
      const name = displayName(user.rows[0].email);
      let organization = await client.query<{ id: string }>(
        `SELECT id FROM organizations WHERE created_by_user_id = $1 AND organization_type = 'personal'`,
        [userId],
      );
      if (!organization.rows[0]) {
        const slug = await uniqueSlug(client, "organizations", `${name}-personal`);
        organization = await client.query<{ id: string }>(
          `INSERT INTO organizations (name, slug, organization_type, created_by_user_id)
           VALUES ($1, $2, 'personal', $3) RETURNING id`,
          [`${name}'s workspace`, slug, userId],
        );
        const createdOrganization = organization.rows[0];
        if (!createdOrganization) throw new Error("Could not create personal organization.");
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [createdOrganization.id, userId],
        );
      }

      const personalOrganization = organization.rows[0];
      if (!personalOrganization) throw new Error("Could not resolve personal organization.");
      const organizationId = personalOrganization.id;
      const slug = await uniqueSlug(client, "workspaces", name, organizationId);
      const workspace = await client.query<{ id: string }>(
        `INSERT INTO workspaces
           (organization_id, name, slug, workspace_type, description, primary_objective, created_by_user_id,
            settings)
         VALUES ($1, $2, $3, 'personal', 'Your personal narrative and creator workspace.',
                 'Build a trusted point of view and grow an audience.', $4,
                 '{"approval_mode":"owner_review"}'::jsonb)
         RETURNING id`,
        [organizationId, name, slug, userId],
      );
      const createdWorkspace = workspace.rows[0];
      if (!createdWorkspace) throw new Error("Could not create personal workspace.");
      workspaceId = createdWorkspace.id;
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO experts (workspace_id, linked_user_id, name, expert_type, is_default)
         VALUES ($1, $2, $3, 'founder', true)`,
        [workspaceId, userId, name],
      );
    }

    if (!user.rows[0].active_workspace_id) {
      await client.query(`UPDATE users SET active_workspace_id = $2 WHERE id = $1`, [userId, workspaceId]);
    }
  });

  const context = await resolveWorkspaceContext(userId);
  if (!context) throw new WorkspaceAccessError();
  return context;
}

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  const rows = await query<WorkspaceRow>(
    `SELECT w.id, w.organization_id, o.name AS organization_name, w.name, w.slug,
            w.workspace_type, w.description, w.primary_objective, w.primary_objective_key,
            w.industry, w.website, wm.role,
            (u.active_workspace_id = w.id) AS active,
            e.id AS default_expert_id, e.name AS default_expert_name
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       JOIN organizations o ON o.id = w.organization_id
       JOIN users u ON u.id = wm.user_id
       LEFT JOIN experts e ON e.workspace_id = w.id AND e.is_default = true
      WHERE wm.user_id = $1
      ORDER BY (u.active_workspace_id = w.id) DESC, w.workspace_type DESC, lower(w.name)`,
    [userId],
  );
  return rows.map(mapWorkspace);
}

export async function resolveWorkspaceContext(
  userId: string,
  explicitWorkspaceId?: string | null,
): Promise<WorkspaceContext | null> {
  const row = await queryOne<WorkspaceRow>(
    `SELECT w.id, w.organization_id, o.name AS organization_name, w.name, w.slug,
            w.workspace_type, w.description, w.primary_objective, w.primary_objective_key,
            w.industry, w.website, wm.role,
            (u.active_workspace_id = w.id) AS active,
            e.id AS default_expert_id, e.name AS default_expert_name
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       JOIN workspaces w ON w.id = wm.workspace_id
       JOIN organizations o ON o.id = w.organization_id
       LEFT JOIN experts e ON e.workspace_id = w.id AND e.is_default = true
      WHERE u.id = $1
        AND w.id = COALESCE($2::uuid, u.active_workspace_id)
      LIMIT 1`,
    [userId, explicitWorkspaceId ?? null],
  );
  return row ? { ...mapWorkspace(row), userId } : null;
}

export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  minimumRole: WorkspaceRole,
): Promise<WorkspaceContext> {
  const context = await resolveWorkspaceContext(userId, workspaceId);
  assertWorkspaceRole(context?.role, minimumRole);
  return context as WorkspaceContext;
}

export async function setActiveWorkspace(userId: string, workspaceId: string): Promise<WorkspaceContext> {
  const context = await requireWorkspaceRole(userId, workspaceId, "viewer");
  await query(`UPDATE users SET active_workspace_id = $2 WHERE id = $1`, [userId, workspaceId]);
  return { ...context, active: true };
}

export async function setTelegramWorkspaceContext(userId: string, workspaceId: string): Promise<WorkspaceContext> {
  const context = await requireWorkspaceRole(userId, workspaceId, "viewer");
  await query(`UPDATE users SET telegram_workspace_id = $2, active_workspace_id = $2 WHERE id = $1`, [
    userId,
    workspaceId,
  ]);
  return { ...context, active: true };
}

/**
 * Preference order for Telegram capture targets:
 * telegram_workspace_id → active_workspace_id → personal workspace.
 * Dedupes identical ids so a fallback is only tried once.
 */
export function telegramCaptureWorkspacePreferenceOrder(
  telegramWorkspaceId: string | null | undefined,
  activeWorkspaceId: string | null | undefined,
  personalWorkspaceId: string | null | undefined,
): string[] {
  const ordered: string[] = [];
  for (const id of [telegramWorkspaceId, activeWorkspaceId, personalWorkspaceId]) {
    if (id && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

export async function resolveTelegramCaptureWorkspace(userId: string): Promise<WorkspaceContext | null> {
  const prefs = await queryOne<{
    telegram_workspace_id: string | null;
    active_workspace_id: string | null;
  }>(`SELECT telegram_workspace_id, active_workspace_id FROM users WHERE id = $1`, [userId]);
  if (!prefs) return null;

  const personal = await queryOne<{ id: string }>(
    `SELECT w.id
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = $1 AND w.workspace_type = 'personal'
      LIMIT 1`,
    [userId],
  );

  for (const workspaceId of telegramCaptureWorkspacePreferenceOrder(
    prefs.telegram_workspace_id,
    prefs.active_workspace_id,
    personal?.id,
  )) {
    const context = await resolveWorkspaceContext(userId, workspaceId);
    if (context) return context;
  }
  return null;
}

export async function createCompanyWorkspace(
  userId: string,
  input: CreateCompanyWorkspaceInput,
): Promise<WorkspaceContext> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 100);
  if (name.length < 2) throw new Error("Workspace name must be at least 2 characters.");

  const entitlements = await entitlementsFor(userId);
  const used = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM workspace_members WHERE user_id = $1`,
    [userId],
  );
  assertWithinCap(
    Number(used?.n ?? 0),
    entitlements.activeWorkspaces,
    "activeWorkspaces",
    "You've reached your workspace limit. Upgrade to add another.",
  );

  const workspaceId = await withTransaction(async (client) => {
    const organizationSlug = await uniqueSlug(client, "organizations", name);
    const organization = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, organization_type, created_by_user_id)
       VALUES ($1, $2, 'company', $3) RETURNING id`,
      [name, organizationSlug, userId],
    );
    const createdOrganization = organization.rows[0];
    if (!createdOrganization) throw new Error("Could not create company organization.");
    const organizationId = createdOrganization.id;
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [organizationId, userId],
    );

    const workspaceSlug = await uniqueSlug(client, "workspaces", name, organizationId);
    const workspace = await client.query<{ id: string }>(
      `INSERT INTO workspaces
         (organization_id, name, slug, workspace_type, description, primary_objective,
          primary_objective_key, industry, website, created_by_user_id)
       VALUES ($1, $2, $3, 'company', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        organizationId,
        name,
        workspaceSlug,
        input.description?.trim().slice(0, 500) || null,
        input.primaryObjective?.trim().slice(0, 240) || null,
        input.primaryObjectiveKey?.trim() || null,
        input.industry?.trim().slice(0, 120) || null,
        input.website?.trim().slice(0, 500) || null,
        userId,
      ],
    );
    const createdWorkspace = workspace.rows[0];
    if (!createdWorkspace) throw new Error("Could not create company workspace.");
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [createdWorkspace.id, userId],
    );
    await client.query(
      `INSERT INTO experts (workspace_id, linked_user_id, name, title, expert_type, is_default)
       VALUES ($1, $2, $3, $4, 'founder', true)`,
      [createdWorkspace.id, userId, input.founderName?.trim() || name, input.founderTitle?.trim() || "Founder"],
    );
    await client.query(`UPDATE users SET active_workspace_id = $2 WHERE id = $1`, [userId, createdWorkspace.id]);
    return createdWorkspace.id;
  });

  const context = await resolveWorkspaceContext(userId, workspaceId);
  if (!context) throw new WorkspaceAccessError();
  return context;
}

export async function resolveDefaultExpert(userId: string, workspaceId: string): Promise<ExpertView | null> {
  await requireWorkspaceRole(userId, workspaceId, "viewer");
  const row = await queryOne<ExpertRow>(
    `SELECT id, workspace_id, linked_user_id, name, title, expert_type, bio, is_default, is_public_voice
       FROM experts WHERE workspace_id = $1 AND is_default = true`,
    [workspaceId],
  );
  return row ? mapExpert(row) : null;
}

export async function listExperts(userId: string, workspaceId: string): Promise<ExpertView[]> {
  await requireWorkspaceRole(userId, workspaceId, "viewer");
  const rows = await query<ExpertRow>(
    `SELECT id, workspace_id, linked_user_id, name, title, expert_type, bio, is_default, is_public_voice
       FROM experts WHERE workspace_id = $1 ORDER BY is_default DESC, lower(name)`,
    [workspaceId],
  );
  return rows.map(mapExpert);
}

export async function getWorkspaceHome(userId:string,workspaceId:string):Promise<WorkspaceHomeView>{
  await requireWorkspaceRole(userId,workspaceId,"viewer");
  const [knowledge,knowledgeCounts,briefs,assets,publications,conversions,narrative]=await Promise.all([
    query<{id:string;title:string;object_type:string;status:string}>(`SELECT id,title,object_type,status FROM knowledge_objects WHERE workspace_id=$1 AND permission_level IN ('public','internal') ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created_at DESC LIMIT 5`,[workspaceId]),
    queryOne<{approved:string;proposed:string}>(`SELECT count(*) FILTER (WHERE status='approved')::text approved,count(*) FILTER (WHERE status='proposed')::text proposed FROM knowledge_objects WHERE workspace_id=$1 AND permission_level IN ('public','internal')`,[workspaceId]),
    queryOne<{n:string}>(`SELECT count(*)::text n FROM content_briefs WHERE workspace_id=$1 AND status='draft'`,[workspaceId]),
    queryOne<{n:string}>(`SELECT count(*)::text n FROM content_assets WHERE workspace_id=$1 AND status IN ('draft','needs_review','approved')`,[workspaceId]),
    query<{id:string;title:string;platform:string;scheduled_for:string}>(`SELECT sp.id,ca.title,sp.platform,sp.scheduled_for::text FROM scheduled_posts sp JOIN content_assets ca ON ca.id=sp.content_asset_id AND ca.workspace_id=sp.workspace_id WHERE sp.workspace_id=$1 AND sp.status='pending' AND sp.scheduled_for>=now() ORDER BY sp.scheduled_for LIMIT 5`,[workspaceId]),
    query<{id:string;event_type:string;asset_title:string|null;occurred_at:string}>(`SELECT ce.id,ce.event_type,ca.title asset_title,ce.occurred_at::text FROM conversion_events ce LEFT JOIN content_assets ca ON ca.id=ce.content_asset_id AND ca.workspace_id=ce.workspace_id WHERE ce.workspace_id=$1 ORDER BY ce.occurred_at DESC LIMIT 5`,[workspaceId]),
    queryOne(`SELECT 1 FROM narrative_systems WHERE workspace_id=$1 AND status='active'`,[workspaceId]),
  ]);
  const approved=Number(knowledgeCounts?.approved??0),proposed=Number(knowledgeCounts?.proposed??0),briefCount=Number(briefs?.n??0),assetCount=Number(assets?.n??0);
  const nextAction=proposed>0?{label:"Review knowledge",description:`${proposed} recent item${proposed===1?" is":"s are"} waiting for a human decision.`,href:"/app/knowledge"}:approved===0?{label:"Add source material",description:"Capture real company knowledge before building strategy.",href:"/app/knowledge"}:!narrative?{label:"Open Studio",description:"Turn approved knowledge into drafts once a narrative exists in Studio.",href:"/app/studio"}:briefCount>0?{label:"Review in Studio",description:`${briefCount} strategic brief${briefCount===1?" needs":"s need"} attention in Studio.`,href:"/app/studio"}:assetCount>0?{label:"Review Assets",description:"Move grounded assets through editorial approval.",href:"/app/assets"}:{label:"Generate in Studio",description:"Turn an audience question into the next grounded content job.",href:"/app/studio"};
  return {recentKnowledge:knowledge.map(item=>({id:item.id,title:item.title,objectType:item.object_type,status:item.status})),briefsNeedingApproval:briefCount,assetsInProduction:assetCount,upcomingPublications:publications.map(item=>({id:item.id,title:item.title,platform:item.platform,scheduledFor:item.scheduled_for})),recentConversions:conversions.map(item=>({id:item.id,eventType:item.event_type,assetTitle:item.asset_title,occurredAt:item.occurred_at})),nextAction};
}

export async function getWorkspaceAdmin(userId:string,workspaceId:string):Promise<WorkspaceAdminView>{const context=await requireWorkspaceRole(userId,workspaceId,"viewer");const sourceVisibility=context.role==="owner"||context.role==="admin"?"TRUE":context.role==="strategist"||context.role==="editor"?"permission_level IN ('public','internal','restricted')":"permission_level IN ('public','internal')";const [workspace,members,experts,sources]=await Promise.all([queryOne<{settings:Record<string,unknown>}>(`SELECT settings FROM workspaces WHERE id=$1`,[workspaceId]),query<WorkspaceMemberView & {user_id:string;joined_at:string}>(`SELECT wm.user_id, u.email, wm.role, wm.joined_at::text FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=$1 ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.email`,[workspaceId]),listExperts(userId,workspaceId),query<{id:string;name:string;source_type:string;permission_level:string;status:string;last_ingested_at:string|null}>(`SELECT id,name,source_type,permission_level,status,last_ingested_at::text FROM workspace_sources WHERE workspace_id=$1 AND ${sourceVisibility} ORDER BY created_at DESC`,[workspaceId])]);return{id:context.id,name:context.name,organizationName:context.organizationName,workspaceType:context.workspaceType,description:context.description,primaryObjective:context.primaryObjective,primaryObjectiveKey:context.primaryObjectiveKey,industry:context.industry,website:context.website,role:context.role,telegramDelivery:context.workspaceType==="personal"||workspace?.settings?.telegram_delivery===true,members:members.map(row=>({userId:row.user_id,email:row.email,role:row.role,joinedAt:row.joined_at})),experts,sources:sources.map((row):WorkspaceSourceView=>({id:row.id,name:row.name,sourceType:row.source_type,permissionLevel:row.permission_level,status:row.status,lastIngestedAt:row.last_ingested_at}))};}

export async function setWorkspaceTelegramDelivery(userId:string,workspaceId:string,enabled:boolean):Promise<void>{await requireWorkspaceRole(userId,workspaceId,"admin");await query(`UPDATE workspaces SET settings=jsonb_set(settings,'{telegram_delivery}',$2::jsonb,true),updated_at=now() WHERE id=$1`,[workspaceId,JSON.stringify(enabled)]);}

export async function updateWorkspaceProfile(userId:string,workspaceId:string,input:{description?:string|null;industry?:string|null;website?:string|null;primaryObjective?:string|null;primaryObjectiveKey?:string|null}):Promise<void>{
  await requireWorkspaceRole(userId,workspaceId,"strategist");
  const objectiveKeys=["category_awareness","founder_authority","inbound_pipeline","product_adoption","developer_adoption","customer_education","sales_enablement","recruiting","fundraising"];
  if(input.primaryObjectiveKey&&!objectiveKeys.includes(input.primaryObjectiveKey))throw new Error("Invalid primary objective.");
  const website=input.website?.trim()||null;
  if(website){
    let url:URL;
    try{url=new URL(website);}
    catch{throw new Error("Website must be a valid HTTP or HTTPS URL.");}
    if(url.protocol!=="http:"&&url.protocol!=="https:")throw new Error("Website must be a valid HTTP or HTTPS URL.");
  }
  await query(`UPDATE workspaces SET description=$2,industry=$3,website=$4,primary_objective=$5,primary_objective_key=$6,updated_at=now() WHERE id=$1`,[workspaceId,input.description?.trim().slice(0,1000)||null,input.industry?.trim().slice(0,120)||null,website?.slice(0,500)||null,input.primaryObjective?.trim().slice(0,500)||null,input.primaryObjectiveKey||null]);
}

export async function updateWorkspaceSource(userId:string,workspaceId:string,sourceId:string,input:{permissionLevel:string;status:string}):Promise<void>{await requireWorkspaceRole(userId,workspaceId,"admin");const permissions=["public","internal","restricted","confidential","never_use_for_generation"],statuses=["active","paused","archived"];if(!permissions.includes(input.permissionLevel)||!statuses.includes(input.status))throw new Error("Invalid source permission or status.");const row=await queryOne<{id:string}>(`UPDATE workspace_sources SET permission_level=$3,status=$4,extraction_policy=CASE WHEN $3='never_use_for_generation' THEN extraction_policy||'{"disabled":true}'::jsonb ELSE extraction_policy-'disabled' END,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING id`,[sourceId,workspaceId,input.permissionLevel,input.status]);if(!row)throw new Error("Source not found in this workspace.");await query(`UPDATE captures SET permission_level=$3 WHERE source_id=$1 AND workspace_id=$2`,[sourceId,workspaceId,input.permissionLevel]);await query(`UPDATE knowledge_objects ko SET permission_level=$3,updated_at=now() FROM captures c WHERE c.id=ko.source_capture_id AND c.source_id=$1 AND ko.workspace_id=$2`,[sourceId,workspaceId,input.permissionLevel]);}

export async function addWorkspaceMemberByEmail(userId:string,workspaceId:string,email:string,role:WorkspaceRole):Promise<void>{
  const actor=await requireWorkspaceRole(userId,workspaceId,"admin");
  if(role==="owner"||(role==="admin"&&actor.role!=="owner"))throw new WorkspaceAccessError("Only an owner can add an admin, and ownership cannot be assigned here.");
  const target=await queryOne<{id:string}>(`SELECT id FROM users WHERE lower(email)=lower($1)`,[email.trim()]);
  if(!target)throw new Error("That person must create a Yoinky account before you can add them.");
  const workspace=await queryOne<{organization_id:string}>(`SELECT organization_id FROM workspaces WHERE id=$1`,[workspaceId]);
  if(!workspace)throw new Error("Workspace not found.");
  const already=await queryOne<{user_id:string}>(`SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,target.id]);
  if(!already){
    const entitlements=await entitlementsFor(userId);
    const members=await queryOne<{n:string}>(`SELECT count(*)::text AS n FROM workspace_members WHERE workspace_id=$1`,[workspaceId]);
    assertWithinCap(Number(members?.n??0),entitlements.membersPerWorkspace,"membersPerWorkspace","This workspace has reached its member limit. Upgrade to add more people.");
  }
  await withTransaction(async client=>{
    await client.query(`INSERT INTO organization_members (organization_id,user_id,role,status,invited_by_user_id) VALUES ($1,$2,$3,'active',$4) ON CONFLICT (organization_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active',updated_at=now()`,[workspace.organization_id,target.id,role,userId]);
    await client.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role,updated_at=now()`,[workspaceId,target.id,role]);
  });
}

export async function updateWorkspaceMemberRole(userId:string,workspaceId:string,targetUserId:string,role:WorkspaceRole):Promise<void>{const actor=await requireWorkspaceRole(userId,workspaceId,"admin");if(role==="owner"||(role==="admin"&&actor.role!=="owner"))throw new WorkspaceAccessError("Only an owner can assign admin access.");const target=await queryOne<{role:WorkspaceRole;organization_id:string}>(`SELECT wm.role,w.organization_id FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.workspace_id=$1 AND wm.user_id=$2`,[workspaceId,targetUserId]);if(!target||target.role==="owner")throw new WorkspaceAccessError("The workspace owner cannot be changed here.");await withTransaction(async client=>{await client.query(`UPDATE workspace_members SET role=$3,updated_at=now() WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,targetUserId,role]);await client.query(`UPDATE organization_members SET role=$3,updated_at=now() WHERE organization_id=$1 AND user_id=$2`,[target.organization_id,targetUserId,role]);});}

export async function addWorkspaceExpert(userId:string,workspaceId:string,input:{name:string;title?:string|null;expertType:ExpertType;isPublicVoice?:boolean}):Promise<ExpertView>{
  await requireWorkspaceRole(userId,workspaceId,"strategist");
  const allowed:ExpertType[]=["founder","executive","product","engineering","sales","customer_success","marketing","external_expert","other"];
  if(!allowed.includes(input.expertType))throw new Error("Unsupported expert type.");
  const entitlements=await entitlementsFor(userId);
  const experts=await queryOne<{n:string}>(`SELECT count(*)::text AS n FROM experts WHERE workspace_id=$1`,[workspaceId]);
  assertWithinCap(Number(experts?.n??0),entitlements.expertsPerWorkspace,"expertsPerWorkspace","This workspace has reached its expert limit. Upgrade to add more voices.");
  const row=await queryOne<{id:string}>(`INSERT INTO experts (workspace_id,name,title,expert_type,is_public_voice) VALUES ($1,$2,$3,$4,$5) RETURNING id`,[workspaceId,input.name.trim().slice(0,120),input.title?.trim().slice(0,120)||null,input.expertType,input.isPublicVoice??false]);
  if(!row)throw new Error("Could not add expert.");
  return (await listExperts(userId,workspaceId)).find(item=>item.id===row.id)!;
}

export async function exportWorkspaceData(userId:string,workspaceId:string):Promise<Record<string,unknown>>{await requireWorkspaceRole(userId,workspaceId,"admin");const table=async(name:string)=>query<Record<string,unknown>>(`SELECT * FROM ${name} WHERE workspace_id=$1`,[workspaceId]);const [workspace,members,experts,expertVoices,sources,captures,knowledge,relationships,audiences,journey,narratives,messages,territories,claims,briefs,briefSources,assets,assetVersions,assetReviews,lineage,campaigns,distribution,actions,conversions,reviews,performance,auditLogs]=await Promise.all([queryOne(`SELECT * FROM workspaces WHERE id=$1`,[workspaceId]),table("workspace_members"),table("experts"),table("expert_voice_profiles"),table("workspace_sources"),table("captures"),table("knowledge_objects"),table("knowledge_relationships"),table("workspace_audiences"),table("buyer_journey_questions"),table("narrative_systems"),query<Record<string,unknown>>(`SELECT nm.* FROM narrative_messages nm JOIN narrative_systems ns ON ns.id=nm.narrative_system_id WHERE ns.workspace_id=$1`,[workspaceId]),table("editorial_territories"),table("claim_registry"),table("content_briefs"),table("content_brief_sources"),table("content_assets"),query<Record<string,unknown>>(`SELECT cav.* FROM content_asset_versions cav JOIN content_assets ca ON ca.id=cav.asset_id WHERE ca.workspace_id=$1`,[workspaceId]),table("asset_reviews"),table("content_lineage"),table("content_campaigns"),table("distribution_steps"),table("conversion_actions"),table("conversion_events"),table("editorial_reviews"),table("publication_performance_snapshots"),table("workspace_audit_logs")]);return{exportedAt:new Date().toISOString(),workspace,members,experts,expertVoices,sources,captures,knowledge,relationships,audiences,journey,narratives,messages,territories,claims,briefs,briefSources,assets,assetVersions,assetReviews,lineage,campaigns,distribution,actions,conversions,reviews,performance,auditLogs};}

export async function deleteCompanyWorkspace(userId:string,workspaceId:string,confirmation:string):Promise<void>{
  const context=await requireWorkspaceRole(userId,workspaceId,"owner");
  if(context.workspaceType!=="company")throw new Error("Personal workspaces cannot be deleted.");
  if(confirmation!==context.name)throw new Error("Type the exact workspace name to confirm deletion.");
  await withTransaction(async client=>{
    const publishing=await client.query(`SELECT 1 FROM scheduled_posts sp JOIN content_assets ca ON ca.id=sp.content_asset_id WHERE ca.workspace_id=$1 AND sp.status='publishing' LIMIT 1`,[workspaceId]);
    if(publishing.rowCount)throw new Error("A publication is currently in progress. Try again after it finishes.");
    const org=await client.query<{organization_id:string}>(`SELECT organization_id FROM workspaces WHERE id=$1`,[workspaceId]);
    const organizationId=org.rows[0]?.organization_id;
    await client.query(`UPDATE scheduled_posts SET status='canceled',updated_at=now() WHERE content_asset_id IN (SELECT id FROM content_assets WHERE workspace_id=$1) AND status='pending'`,[workspaceId]);
    await client.query(`DELETE FROM workspaces WHERE id=$1`,[workspaceId]);
    if(organizationId){
      const remaining=await client.query<{n:string}>(`SELECT count(*)::text n FROM workspaces WHERE organization_id=$1`,[organizationId]);
      if(Number(remaining.rows[0]?.n??0)===0){
        await client.query(`DELETE FROM organizations WHERE id=$1`,[organizationId]);
      }
    }
    await client.query(`UPDATE users SET active_workspace_id=(SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=$1 AND w.workspace_type='personal' LIMIT 1) WHERE id=$1`,[userId]);
  });
}
