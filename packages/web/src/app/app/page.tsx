import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listKnowledgeObjects, resolveWorkspaceContext, roleAtLeast, setIntendedPlan } from "@yoink/backend/web";
import { Inbox } from "@/components/inbox";

export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const params = await searchParams;
  const plan = one(params.plan);
  if (plan) await setIntendedPlan(user.id, plan).catch(() => {});

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
