import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listContentAssets, listContentBriefs, resolveWorkspaceContext, roleAtLeast } from "@yoink/backend/web";
import { BriefWorkbench } from "@/components/brief-workbench";

export const dynamic="force-dynamic";
export default async function BriefsPage(){
  const user=await getSessionUser(); if(!user)redirect("/sign-in");
  const workspace=await resolveWorkspaceContext(user.id); if(!workspace)redirect("/app/workspaces/new");
  const [briefs,assets]=await Promise.all([listContentBriefs(user.id,workspace.id),listContentAssets(user.id,workspace.id)]);
  return <BriefWorkbench initialBriefs={briefs} initialAssets={assets} canCreate={roleAtLeast(workspace.role,"contributor")} canReview={roleAtLeast(workspace.role,"editor")}/>;
}

