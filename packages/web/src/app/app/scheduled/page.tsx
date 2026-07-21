import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listScheduled } from "@yoink/backend/web";
import { ScheduledCalendar } from "@/components/scheduled-calendar";

export const dynamic = "force-dynamic";

export default async function ScheduledPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const posts = await listScheduled(user.id).catch(() => []);
  return (
    <ScheduledCalendar
      posts={posts.map((p) => ({ id: p.id, platform: p.platform, content: p.content, scheduledFor: p.scheduled_for }))}
    />
  );
}
