import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { DistributionWorkbench } from "@/components/distribution-workbench";
import { listCampaigns,listContentAssets,listConversionActions,listConversionEvents,listDistributionSteps,resolveWorkspaceContext,roleAtLeast } from "@yoink/backend/web";

export const dynamic="force-dynamic";
export default async function DistributionPage() {
  const user=await getSessionUser();if(!user)redirect("/sign-in");const workspace=await resolveWorkspaceContext(user.id);if(!workspace)redirect("/app/workspaces/new");
  const [assets,steps,actions,events,campaigns]=await Promise.all([listContentAssets(user.id,workspace.id),listDistributionSteps(user.id,workspace.id),listConversionActions(user.id,workspace.id),listConversionEvents(user.id,workspace.id),listCampaigns(user.id,workspace.id)]);
  return <DistributionWorkbench initialAssets={assets} initialSteps={steps} initialActions={actions} initialEvents={events} initialCampaigns={campaigns} canCreate={roleAtLeast(workspace.role,"contributor")} canReview={roleAtLeast(workspace.role,"editor")} canStrategize={roleAtLeast(workspace.role,"strategist")}/>;
}
