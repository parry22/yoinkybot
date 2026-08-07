import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getAnalytics,getWorkspaceIntelligence,resolveWorkspaceContext,roleAtLeast } from "@yoink/backend/web";
import { Analytics } from "@/components/analytics";
import { WorkspaceIntelligence } from "@/components/workspace-intelligence";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const workspace=await resolveWorkspaceContext(user.id);
  const [data,intelligence]=await Promise.all([getAnalytics(user.id),workspace?getWorkspaceIntelligence(user.id,workspace.id):null]);
  return <>{workspace&&intelligence&&<WorkspaceIntelligence data={intelligence} canReview={roleAtLeast(workspace.role,"strategist")}/>}<Analytics data={data} /></>;
}
