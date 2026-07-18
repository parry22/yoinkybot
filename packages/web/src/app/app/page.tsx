import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { loadChatHistory, getStage } from "@yoink/backend/web";
import { ChatWorkspace } from "@/components/chat";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [history, stage] = await Promise.all([
    loadChatHistory(user.id).catch(() => []),
    getStage(user.id).catch(() => "new"),
  ]);
  const onboarding = !(stage === "active" || stage === "plan_active");

  return (
    <ChatWorkspace
      initial={history.map((h) => ({ role: h.role, text: h.content }))}
      onboarding={onboarding}
    />
  );
}
