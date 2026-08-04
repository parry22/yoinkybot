/**
 * Web-side media staging for scheduled posts.
 *
 * The web route puts the file into Vercel Blob (it holds the token; the backend
 * never does) and then calls `stageMedia` here with the resulting URL. That
 * inserts a `scheduled_post_media` row with a NULL scheduled_post_id — staged,
 * not yet attached — because the user picks a file while they're still writing the
 * text, so the post row doesn't exist yet. `schedulePost` binds them on save.
 *
 * Validation lives HERE rather than in the route so the size/type rules are the
 * same ones the publisher enforces (social/media.ts), not a second copy that can
 * drift from them.
 */
import { query, queryOne } from "../db/pool.js";
import {
  kindForMime,
  maxBytesFor,
  validateMediaSet,
  hasMediaScope,
  MEDIA_LIMITS,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_GIF_TYPES,
  ALLOWED_VIDEO_TYPES,
  type MediaKind,
} from "../social/media.js";

/** Every mime type the picker may offer, for the UI's `accept` attribute. */
export const ACCEPTED_MEDIA_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_GIF_TYPES, ...ALLOWED_VIDEO_TYPES];

export { MEDIA_LIMITS };

export interface StagedMediaView {
  id: string;
  kind: MediaKind;
  url: string;
  mimeType: string;
  byteSize: number;
  altText: string | null;
}

export interface StageMediaResult {
  ok: boolean;
  media?: StagedMediaView;
  reason?: string;
}

export interface StageMediaInput {
  url: string;
  blobPath: string;
  mimeType: string;
  byteSize: number;
  altText?: string;
}

/** Human-readable size, for rejection messages that say what the limit was. */
function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

/**
 * Record an uploaded file as staged media. Returns a plain reason on rejection so
 * the route can 400 with something the user can act on.
 */
export async function stageMedia(userId: string, input: StageMediaInput): Promise<StageMediaResult> {
  const kind = kindForMime(input.mimeType);
  if (!kind) {
    return { ok: false, reason: `${input.mimeType} isn't a format X accepts — use JPEG, PNG, WebP, GIF or MP4` };
  }
  const max = maxBytesFor(kind);
  if (input.byteSize > max) {
    return { ok: false, reason: `that ${kind} is ${mb(input.byteSize)} — the limit is ${mb(max)}` };
  }
  if (input.byteSize <= 0) return { ok: false, reason: "that file came through empty" };

  const row = await queryOne<{ id: string }>(
    `INSERT INTO scheduled_post_media
       (scheduled_post_id, user_id, kind, url, blob_path, mime_type, byte_size, alt_text)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [userId, kind, input.url, input.blobPath, input.mimeType, input.byteSize, input.altText?.slice(0, 1000) ?? null],
  );
  if (!row) return { ok: false, reason: "couldn't save that upload" };

  return {
    ok: true,
    media: {
      id: row.id,
      kind,
      url: input.url,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      altText: input.altText ?? null,
    },
  };
}

/** Drop a staged attachment the user removed before saving the post. */
export async function discardStagedMedia(userId: string, mediaId: string): Promise<{ ok: boolean }> {
  // Only ever deletes STAGED rows: once bound to a post, removal is the post's
  // business (and cascades when the post is deleted).
  const row = await queryOne<{ id: string }>(
    `DELETE FROM scheduled_post_media
     WHERE id = $1 AND user_id = $2 AND scheduled_post_id IS NULL RETURNING id`,
    [mediaId, userId],
  );
  return { ok: Boolean(row) };
}

export interface MediaReadiness {
  /** True when this user can actually publish media (token has media.write). */
  canPostMedia: boolean;
  /** Set when they need to reconnect X before media will go out. */
  warning: string | null;
}

/**
 * Whether media will actually publish for this user. Surfaced in the scheduler UI
 * up front, because the alternative is finding out at the scheduled time.
 */
export async function mediaReadiness(userId: string, platform: "x" | "linkedin" = "x"): Promise<MediaReadiness> {
  const ok = await hasMediaScope(userId, platform).catch(() => false);
  const label = platform === "x" ? "X" : "LinkedIn";
  return {
    canPostMedia: ok,
    warning: ok
      ? null
      : platform === "x"
        ? "Reconnect your X account in Settings to attach images or video — the permission to upload media was added after you connected."
        : `Connect ${label} for posting in Settings before scheduling images or video.`,
  };
}

/** Attachments already on a scheduled post, for rendering the calendar. */
export async function mediaForScheduledPosts(
  userId: string,
  postIds: string[],
): Promise<Map<string, StagedMediaView[]>> {
  const out = new Map<string, StagedMediaView[]>();
  if (postIds.length === 0) return out;
  const rows = await query<{
    scheduled_post_id: string;
    id: string;
    kind: MediaKind;
    url: string;
    mime_type: string;
    byte_size: string;
    alt_text: string | null;
  }>(
    `SELECT scheduled_post_id, id, kind, url, mime_type, byte_size::text, alt_text
     FROM scheduled_post_media
     WHERE user_id = $1 AND scheduled_post_id = ANY($2::uuid[])
     ORDER BY position ASC, created_at ASC`,
    [userId, postIds],
  );
  for (const r of rows) {
    const list = out.get(r.scheduled_post_id) ?? [];
    list.push({
      id: r.id,
      kind: r.kind,
      url: r.url,
      mimeType: r.mime_type,
      byteSize: Number(r.byte_size),
      altText: r.alt_text,
    });
    out.set(r.scheduled_post_id, list);
  }
  return out;
}

/**
 * Validate a staged set before the post is saved — same rule the publisher uses,
 * so "4 images max, no mixing video with images" is refused at schedule time
 * rather than at publish time.
 */
export async function validateStagedSet(userId: string, mediaIds: string[]): Promise<{ ok: boolean; reason?: string }> {
  if (mediaIds.length === 0) return { ok: true };
  const rows = await query<{ kind: MediaKind }>(
    `SELECT kind FROM scheduled_post_media
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND scheduled_post_id IS NULL`,
    [userId, mediaIds],
  );
  if (rows.length !== mediaIds.length) {
    return { ok: false, reason: "one of those attachments is no longer available — re-upload it" };
  }
  const problem = validateMediaSet(rows);
  return problem ? { ok: false, reason: problem.reason } : { ok: true };
}
