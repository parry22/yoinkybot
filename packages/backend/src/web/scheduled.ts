/**
 * Web-side manual scheduling. The Scheduled screen's calendar lets a user write a
 * post, attach media and drop it on a day; this wraps the existing schedulePost
 * (which enforces no-links + future-time + the plan cap) and adds the content
 * gate and the media-set check. ensureBoss() first, because the web process
 * enqueues the publish job into pg-boss like the other web wrappers do.
 */
import { ensureBoss } from "../jobs/boss.js";
import { schedulePost, type ScheduleResult } from "../scheduling/service.js";
import { assertClean } from "../moderation/filter.js";
import { validateStagedSet } from "./media.js";

export async function createWebScheduledPost(
  userId: string,
  content: string,
  scheduledForIso: string,
  mediaIds: string[] = [],
): Promise<ScheduleResult> {
  // An image on its own is a valid post, so empty text is only gated when there
  // is also nothing attached (schedulePost makes that call).
  if (content) assertClean(content); // throws ModerationError → 400 at the route
  // The media set is validated here, before a post row exists, so "you can't mix
  // a video and images" is a schedule-time rejection rather than a publish-time
  // surprise hours later.
  const set = await validateStagedSet(userId, mediaIds);
  if (!set.ok) return { ok: false, reason: set.reason };
  await ensureBoss();
  return schedulePost(userId, {
    platform: "x",
    content,
    scheduledFor: new Date(scheduledForIso),
    mediaIds,
  });
}
