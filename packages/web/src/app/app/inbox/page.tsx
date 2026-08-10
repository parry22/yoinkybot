import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import {
  listKnowledgeObjects,
  resolveWorkspaceContext,
  roleAtLeast,
} from "@yoink/backend/web";
import { Inbox } from "@/components/inbox";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const workspace = await resolveWorkspaceContext(user.id);
  if (!workspace) redirect("/app/workspaces/new");

  const objects = await listKnowledgeObjects(user.id, workspace.id).catch(() => []);
  return (
    <Inbox
      workspaceName={workspace.name}
      initialItems={objects}
      canReview={roleAtLeast(workspace.role, "editor")}
    />
  );
}
