import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listDrafts } from "@yoink/backend/web";
import { Compose } from "@/components/compose";

export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const drafts = await listDrafts(user.id).catch(() => []);
  return (
    <Compose
      initialDrafts={drafts.map((d) => ({
        id: d.id,
        content: d.content,
        platform: d.platform,
        created_at: d.created_at,
      }))}
    />
  );
}
