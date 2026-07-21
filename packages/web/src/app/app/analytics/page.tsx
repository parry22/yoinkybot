import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getAnalytics } from "@yoink/backend/web";
import { Analytics } from "@/components/analytics";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const data = await getAnalytics(user.id);
  return <Analytics data={data} />;
}
