/**
 * Media for scheduled posts: what's allowed, and how bytes get from Blob storage
 * onto the platform at publish time.
 *
 * SHAPE OF THE FLOW. The web route uploads the file to Vercel Blob and inserts a
 * `scheduled_post_media` row holding the URL — no bytes ever land in Postgres.
 * At publish time this module fetches that URL (a plain public GET, so the
 * Railway publisher needs no storage credential) and pushes it to the platform's
 * media endpoint, then hands the resulting media ids to the post call.
 *
 * X's rules are the binding constraint and are enforced here rather than trusted
 * from the UI: up to 4 images, OR exactly 1 video, OR 1 GIF — never mixed.
 */
import { config } from "../config.js";
import { query } from "../db/pool.js";
import type { Platform } from "../lib/types.js";
import type { WriteAuth } from "./publish.js";

export type MediaKind = "image" | "gif" | "video";

export interface ScheduledMedia {
  id: string;
  kind: MediaKind;
  url: string;
  mimeType: string;
  byteSize: number;
  altText: string | null;
  externalMediaId: string | null;
}

/** Platform limits, enforced server-side. X's published limits as of 2026. */
export const MEDIA_LIMITS = {
  maxImages: 4,
  maxVideos: 1,
  maxGifs: 1,
  /** 5 MB per image (X's documented still-image ceiling). */
  maxImageBytes: 5 * 1024 * 1024,
  /** 15 MB for an animated GIF. */
  maxGifBytes: 15 * 1024 * 1024,
  /** 512 MB is X's ceiling; we cap lower to keep one publish inside its window. */
  maxVideoBytes: 200 * 1024 * 1024,
} as const;

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ALLOWED_GIF_TYPES = ["image/gif"];
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"];

/** The kind a mime type maps to, or null when we don't accept it at all. */
export function kindForMime(mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  if (ALLOWED_GIF_TYPES.includes(m)) return "gif";
  if (ALLOWED_IMAGE_TYPES.includes(m)) return "image";
  if (ALLOWED_VIDEO_TYPES.includes(m)) return "video";
  return null;
}

export function maxBytesFor(kind: MediaKind): number {
  if (kind === "video") return MEDIA_LIMITS.maxVideoBytes;
  if (kind === "gif") return MEDIA_LIMITS.maxGifBytes;
  return MEDIA_LIMITS.maxImageBytes;
}

export interface MediaSetProblem {
  reason: string;
}

/**
 * Whether a set of attachments is postable as one post. Pure, so the web route
 * and the publisher can both check it and agree.
 */
export function validateMediaSet(items: Array<{ kind: MediaKind }>): MediaSetProblem | null {
  if (items.length === 0) return null;
  const images = items.filter((i) => i.kind === "image").length;
  const videos = items.filter((i) => i.kind === "video").length;
  const gifs = items.filter((i) => i.kind === "gif").length;

  if (videos > 0 && (images > 0 || gifs > 0)) {
    return { reason: "a video can't be posted alongside images — pick one or the other" };
  }
  if (gifs > 0 && images > 0) {
    return { reason: "a GIF can't be posted alongside images — pick one or the other" };
  }
  if (videos > MEDIA_LIMITS.maxVideos) return { reason: "only one video per post" };
  if (gifs > MEDIA_LIMITS.maxGifs) return { reason: "only one GIF per post" };
  if (images > MEDIA_LIMITS.maxImages) return { reason: `up to ${MEDIA_LIMITS.maxImages} images per post` };
  return null;
}

/** Attachments for a scheduled post, in display order. */
export async function mediaForPost(scheduledPostId: string): Promise<ScheduledMedia[]> {
  const rows = await query<{
    id: string;
    kind: MediaKind;
    url: string;
    mime_type: string;
    byte_size: string;
    alt_text: string | null;
    external_media_id: string | null;
  }>(
    `SELECT id, kind, url, mime_type, byte_size::text, alt_text, external_media_id
     FROM scheduled_post_media WHERE scheduled_post_id = $1 ORDER BY position ASC, created_at ASC`,
    [scheduledPostId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    url: r.url,
    mimeType: r.mime_type,
    byteSize: Number(r.byte_size),
    altText: r.alt_text,
    externalMediaId: r.external_media_id,
  }));
}

/** Bind staged uploads (scheduled_post_id IS NULL) to the post that now exists. */
export async function attachMediaToPost(
  userId: string,
  scheduledPostId: string,
  mediaIds: string[],
): Promise<number> {
  if (mediaIds.length === 0) return 0;
  // Ownership is in the WHERE clause, so a guessed id from another user attaches
  // nothing rather than leaking their file into this post.
  const rows = await query<{ id: string }>(
    `UPDATE scheduled_post_media AS m
     SET scheduled_post_id = $2,
         position = idx.ord
     FROM unnest($3::uuid[]) WITH ORDINALITY AS idx(media_id, ord)
     WHERE m.id = idx.media_id AND m.user_id = $1 AND m.scheduled_post_id IS NULL
     RETURNING m.id`,
    [userId, scheduledPostId, mediaIds],
  );
  return rows.length;
}

/** Remember the platform's media id so a retry doesn't re-upload the bytes. */
async function rememberExternalId(mediaId: string, externalId: string): Promise<void> {
  await query(`UPDATE scheduled_post_media SET external_media_id = $2 WHERE id = $1`, [mediaId, externalId]);
}

export interface MediaUploadResult {
  ok: boolean;
  mediaIds: string[];
  error?: string;
}

const FETCH_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** X's chunked APPEND ceiling per chunk is 5 MB; 4 keeps headroom for framing. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** X's async transcode state, returned by FINALIZE and the status endpoint. */
interface XProcessingInfo {
  state?: string;
  check_after_secs?: number;
  error?: { message?: string };
}

/**
 * Pull the stored bytes back out of Blob. Public URL → plain GET, no credential.
 * Returns an ArrayBuffer rather than a typed-array view: `new Blob([view])` is
 * rejected under the web package's stricter DOM lib (a view may be backed by a
 * SharedArrayBuffer, which is not a BlobPart), and slicing the buffer directly is
 * both simpler and copies once instead of twice.
 */
async function fetchMediaBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Upload one asset to X and return its media id.
 *
 * Uses the v2 media endpoints, which accept the same OAuth 2.0 user-context token
 * the post call already uses (the older v1.1 upload host requires OAuth 1.0a, which
 * this codebase has no signing path for). Images go up in one request; video and
 * GIF go through INIT → APPEND → FINALIZE, then wait for transcoding.
 */
async function uploadToX(auth: WriteAuth, item: ScheduledMedia): Promise<string> {
  const bytes = await fetchMediaBytes(item.url);
  const category =
    item.kind === "video" ? "tweet_video" : item.kind === "gif" ? "tweet_gif" : "tweet_image";

  if (item.kind === "image") {
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: item.mimeType }));
    form.append("media_category", category);
    const res = await fetch("https://api.x.com/2/media/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { id?: string; media_key?: string };
      detail?: string;
      title?: string;
    };
    const id = body.data?.id ?? body.data?.media_key;
    if (!res.ok || !id) {
      throw new Error(`X media upload ${res.status}: ${body.detail ?? body.title ?? "rejected"}`);
    }
    return id;
  }

  // ── Chunked: INIT → APPEND* → FINALIZE → wait for transcode ──────────────
  const initRes = await fetch("https://api.x.com/2/media/upload/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: item.mimeType,
      total_bytes: bytes.byteLength,
      media_category: category,
    }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const initBody = (await initRes.json().catch(() => ({}))) as {
    data?: { id?: string };
    detail?: string;
    title?: string;
  };
  const mediaId = initBody.data?.id;
  if (!initRes.ok || !mediaId) {
    throw new Error(`X media init ${initRes.status}: ${initBody.detail ?? initBody.title ?? "rejected"}`);
  }

  let segment = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const chunk = bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
    const form = new FormData();
    form.append("media", new Blob([chunk], { type: "application/octet-stream" }));
    form.append("segment_index", String(segment));
    const res = await fetch(`https://api.x.com/2/media/upload/${mediaId}/append`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`X media append ${res.status} (segment ${segment}): ${detail.slice(0, 200)}`);
    }
    segment++;
  }

  const finRes = await fetch(`https://api.x.com/2/media/upload/${mediaId}/finalize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const finBody = (await finRes.json().catch(() => ({}))) as {
    data?: { id?: string; processing_info?: XProcessingInfo };
    detail?: string;
  };
  if (!finRes.ok) throw new Error(`X media finalize ${finRes.status}: ${finBody.detail ?? "rejected"}`);

  // Video and GIF transcode asynchronously. Posting before it finishes fails, so
  // poll the state X tells us to wait for — bounded, then give up honestly.
  let info = finBody.data?.processing_info;
  const deadline = Date.now() + 5 * 60_000;
  while (info && (info.state === "pending" || info.state === "in_progress") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, info?.check_after_secs ?? 5) * 1000));
    const stRes = await fetch(`https://api.x.com/2/media/upload?media_id=${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const stBody = (await stRes.json().catch(() => ({}))) as {
      data?: { processing_info?: XProcessingInfo };
    };
    info = stBody.data?.processing_info;
    if (info?.state === "failed") {
      throw new Error(`X rejected the video while processing: ${info.error?.message ?? "no reason given"}`);
    }
  }
  if (info && info.state !== "succeeded" && info.state !== undefined) {
    throw new Error("X was still processing the video after 5 minutes — it didn't go out");
  }
  return mediaId;
}

/**
 * Upload every attachment for a post and return the platform media ids, in order.
 *
 * LinkedIn is deliberately not implemented: its media flow is a different
 * (versioned REST) API from the `/v2/ugcPosts` call publish.ts makes, and the web
 * scheduler only queues X posts today. Rather than half-build it, a LinkedIn post
 * with media fails with a plain reason.
 */
export async function uploadMediaFor(
  auth: WriteAuth,
  platform: Platform,
  items: ScheduledMedia[],
): Promise<MediaUploadResult> {
  if (items.length === 0) return { ok: true, mediaIds: [] };
  if (platform !== "x") {
    return { ok: false, mediaIds: [], error: "attaching media to LinkedIn posts isn't supported yet" };
  }
  const problem = validateMediaSet(items);
  if (problem) return { ok: false, mediaIds: [], error: problem.reason };

  const mediaIds: string[] = [];
  for (const item of items) {
    // Already uploaded on an earlier attempt — reuse rather than re-push bytes.
    if (item.externalMediaId) {
      mediaIds.push(item.externalMediaId);
      continue;
    }
    try {
      const id = await uploadToX(auth, item);
      await rememberExternalId(item.id, id).catch(() => {});
      mediaIds.push(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // All-or-nothing: a post that was meant to carry three images must not go
      // out with two. The caller marks the post failed and says why.
      return { ok: false, mediaIds: [], error: reason };
    }
  }
  return { ok: true, mediaIds };
}

/** Whether this instance can post media at all (same app credentials as posting). */
export function mediaUploadConfigured(platform: Platform): boolean {
  return platform === "x" && !!(config.X_CLIENT_ID && config.X_CLIENT_SECRET);
}

/**
 * Whether the user's stored X token actually carries `media.write`.
 *
 * Tokens minted before that scope was added to the consent URL (routes/oauth.ts)
 * do not have it, and X rejects the upload rather than the post — so without this
 * check a returning user would attach an image, wait for the scheduled time, and
 * only then find out. Checked at SCHEDULE time so they're told immediately.
 */
export async function hasMediaScope(userId: string, platform: Platform): Promise<boolean> {
  if (platform !== "x") return false;
  const rows = await query<{ post_scopes: string | null; post_access_token: string | null }>(
    `SELECT post_scopes, post_access_token FROM connected_accounts
     WHERE user_id = $1 AND platform = $2 LIMIT 1`,
    [userId, platform],
  );
  const row = rows[0];
  if (!row?.post_access_token) return false;
  // X returns the granted scopes space-separated on the token response.
  return (row.post_scopes ?? "").split(/\s+/).includes("media.write");
}
