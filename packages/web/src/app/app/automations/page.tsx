import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listAutomationsForWeb, listPendingApprovalsWeb, entitlementsFor } from "@yoink/backend/web";
import { Automations } from "@/components/automations";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const [automations, approvals, ent] = await Promise.all([
    listAutomationsForWeb(user.id).catch(() => []),
    listPendingApprovalsWeb(user.id).catch(() => []),
    entitlementsFor(user.id),
  ]);
  return (
    <Automations
      initialAutomations={automations}
      initialApprovals={approvals}
      canAutoAgent={ent.autoAgent}
    />
  );
}
