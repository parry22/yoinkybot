import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { getGrowthState } from "@yoink/backend/web";
import { Growth } from "@/components/growth";

export const dynamic = "force-dynamic";

export default async function GrowthPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const data = await getGrowthState(user.id);
  return <Growth data={data} />;
}
