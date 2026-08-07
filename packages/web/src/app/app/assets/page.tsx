import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listContentAssets, resolveWorkspaceContext } from "@yoink/backend/web";
import { AssetsLibrary } from "@/components/assets-library";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) redirect("/app/workspaces/new");

  const assets = await listContentAssets(user.id, workspace.id).catch(() => []);
  return <AssetsLibrary assets={assets} />;
}
