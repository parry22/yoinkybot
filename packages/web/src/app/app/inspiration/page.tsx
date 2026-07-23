import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listTrendInspiration, listViralInspiration } from "@yoink/backend/web";
import { Inspiration } from "@/components/inspiration";

export const dynamic = "force-dynamic";

export default async function InspirationPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const [trends, virals] = await Promise.all([
    listTrendInspiration(user.id).catch(() => []),
    listViralInspiration(user.id).catch(() => []),
  ]);

  return <Inspiration trends={trends} virals={virals} />;
}
