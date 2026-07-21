/**
 * Web-side manual scheduling. The Scheduled screen's calendar lets a user write a
 * post and drop it on a day; this wraps the existing schedulePost (which enforces
 * no-links + future-time) and adds the content gate. ensureBoss() first, because
 * the web process enqueues the publish job into pg-boss like the other web
 * wrappers do.
 */
import { ensureBoss } from "../jobs/boss.js";
import { schedulePost, type ScheduleResult } from "../scheduling/service.js";
import { assertClean } from "../moderation/filter.js";

export async function createWebScheduledPost(
  userId: string,
  content: string,
  scheduledForIso: string,
): Promise<ScheduleResult> {
  assertClean(content); // throws ModerationError → 400 at the route
  await ensureBoss();
  return schedulePost(userId, { platform: "x", content, scheduledFor: new Date(scheduledForIso) });
}
