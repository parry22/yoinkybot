import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listScheduled, scheduledStatus } from "@yoink/backend/web";
import { ScheduledCalendar } from "@/components/scheduled-calendar";

export const dynamic = "force-dynamic";

export default async function ScheduledPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const [posts, status] = await Promise.all([
    listScheduled(user.id).catch(() => []),
    scheduledStatus(user.id).catch(() => ({ used: 0, cap: null, remaining: null })),
  ]);
  return (
    <ScheduledCalendar
      posts={posts.map((p) => ({ id: p.id, platform: p.platform, content: p.content, scheduledFor: p.scheduled_for }))}
      usage={{ used: status.used, cap: status.cap }}
    />
  );
}
