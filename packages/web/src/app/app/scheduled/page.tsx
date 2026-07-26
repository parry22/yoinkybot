import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import {
  listScheduled,
  scheduledStatus,
  mediaReadiness,
  mediaForScheduledPosts,
  type StagedMediaView,
} from "@yoink/backend/web";
import { ScheduledCalendar } from "@/components/scheduled-calendar";

export const dynamic = "force-dynamic";

export default async function ScheduledPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const [posts, status, media] = await Promise.all([
    listScheduled(user.id).catch(() => []),
    scheduledStatus(user.id).catch(() => ({ used: 0, cap: null, remaining: null })),
    // Whether their X token can actually upload media — surfaced in the composer
    // so a missing permission is known at attach time, not at publish time.
    mediaReadiness(user.id).catch(() => ({ canPostMedia: false, warning: null })),
  ]);
  const attachments = await mediaForScheduledPosts(
    user.id,
    posts.map((p) => p.id),
  ).catch(() => new Map<string, StagedMediaView[]>());

  return (
    <ScheduledCalendar
      posts={posts.map((p) => ({
        id: p.id,
        platform: p.platform,
        content: p.content,
        scheduledFor: p.scheduled_for,
        media: attachments.get(p.id) ?? [],
      }))}
      usage={{ used: status.used, cap: status.cap }}
      media={media}
    />
  );
}
