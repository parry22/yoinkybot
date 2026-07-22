import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listAutomationsForWeb, listPendingApprovalsWeb } from "@yoink/backend/web";
import { Automations } from "@/components/automations";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const [automations, approvals] = await Promise.all([
    listAutomationsForWeb(user.id).catch(() => []),
    listPendingApprovalsWeb(user.id).catch(() => []),
  ]);
  return <Automations initialAutomations={automations} initialApprovals={approvals} />;
}
