import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listKnowledgeObjects, resolveWorkspaceContext } from "@yoink/backend/web";
import { Studio } from "@/components/studio";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) redirect("/app/workspaces/new");
  const knowledge = await listKnowledgeObjects(user.id, workspace.id).catch(() => []);

  return (
    <Suspense fallback={<div style={{ padding: 32 }}>Loading studio…</div>}>
      <Studio workspaceName={workspace.name} knowledge={knowledge} />
    </Suspense>
  );
}
