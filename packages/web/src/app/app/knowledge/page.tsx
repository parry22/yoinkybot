import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import {
  listExperts,
  listKnowledgeObjects,
  resolveWorkspaceContext,
  roleAtLeast,
  getWorkspaceAdmin,
  getNarrativeArchitecture,
  listNarrativeSystems,
} from "@yoink/backend/web";
import { KnowledgeLibrary } from "@/components/knowledge-library";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) redirect("/app/workspaces/new");
  const [objects, experts, admin, architecture, narratives] = await Promise.all([
    listKnowledgeObjects(user.id, workspace.id).catch(() => []),
    listExperts(user.id, workspace.id).catch(() => []),
    getWorkspaceAdmin(user.id, workspace.id).catch(() => null),
    getNarrativeArchitecture(user.id, workspace.id).catch(() => null),
    listNarrativeSystems(user.id, workspace.id).catch(() => []),
  ]);
  return (
    <Suspense fallback={<div style={{ padding: 32 }}>Loading knowledge…</div>}>
      <KnowledgeLibrary
        workspaceName={workspace.name}
        experts={experts}
        initialObjects={objects}
        sources={admin?.sources ?? []}
        audiences={architecture?.audiences ?? []}
        territories={narratives.find((narrative) => narrative.status === "active")?.territories ?? []}
        canReview={roleAtLeast(workspace.role, "editor")}
      />
    </Suspense>
  );
}
