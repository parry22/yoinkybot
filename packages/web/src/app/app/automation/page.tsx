import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getAgentState, getAnalytics } from "@yoink/backend/web";
import { Automation } from "@/components/automation";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [state, analytics] = await Promise.all([
    getAgentState(user.id),
    getAnalytics(user.id).catch(() => null),
  ]);

  return (
    <Automation
      initialState={state}
      topPosts={(analytics?.topPosts ?? []).map((p) => ({ text: p.text, impressions: p.impressions }))}
    />
  );
}
