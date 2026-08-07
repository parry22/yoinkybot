import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getNarrativeArchitecture, listKnowledgeObjects, listNarrativeSystems, resolveWorkspaceContext, roleAtLeast } from "@yoink/backend/web";
import { NarrativeBuilder } from "@/components/narrative-builder";

export const dynamic = "force-dynamic";

export default async function NarrativePage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) redirect("/app/workspaces/new");
  const [systems,architecture,knowledge] = await Promise.all([listNarrativeSystems(user.id, workspace.id),getNarrativeArchitecture(user.id,workspace.id),listKnowledgeObjects(user.id,workspace.id)]);
  return <NarrativeBuilder initialSystems={systems} initialArchitecture={architecture} proofOptions={knowledge.filter(item=>item.objectType==="proof"&&item.status==="approved"&&["public","internal"].includes(item.permissionLevel)).map(item=>({id:item.id,title:item.title}))} canBuild={roleAtLeast(workspace.role, "strategist")} canReviewClaims={roleAtLeast(workspace.role,"editor")} canReviewHighRisk={roleAtLeast(workspace.role,"admin")} />;
}
