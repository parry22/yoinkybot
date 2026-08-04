import { queryOne } from "../db/pool.js";
import { ensureWriteAuth } from "../social/publish.js";
import { stageRemoteMedia } from "../social/media.js";
import type { ImportedMedia } from "../capture/imports/x.js";
import { repurposeContent, type RepurposeResult } from "./repurpose.js";

interface CaptureRow {
  id: string;
  raw_text: string;
  metadata: { url?: string; media?: ImportedMedia[] };
}

interface XApiPost {
  text: string;
  media: ImportedMedia[];
}

function tweetId(url: string): string | null {
  return url.match(/(?:status|statuses)\/(\d+)/)?.[1] ?? (/^\d+$/.test(url.trim()) ? url.trim() : null);
}

async function ownedXPost(userId: string, url: string): Promise<XApiPost | null> {
  const id = tweetId(url);
  if (!id) return null;
  const resolved = await ensureWriteAuth(userId, "x");
  if (!resolved.ok) return null;
  const headers = { Authorization: `Bearer ${resolved.auth.accessToken}` };
  const [meRes, postRes] = await Promise.all([
    fetch("https://api.x.com/2/users/me", { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(
      `https://api.x.com/2/tweets/${id}?expansions=attachments.media_keys&tweet.fields=author_id&media.fields=type,url,preview_image_url,variants,alt_text`,
      { headers, signal: AbortSignal.timeout(15_000) },
    ),
  ]);
  const me = (await meRes.json().catch(() => ({}))) as { data?: { id?: string } };
  const post = (await postRes.json().catch(() => ({}))) as {
    data?: { text?: string; author_id?: string };
    includes?: {
      media?: Array<{
        type?: string;
        url?: string;
        preview_image_url?: string;
        alt_text?: string;
        variants?: Array<{ url?: string; content_type?: string; bit_rate?: number }>;
      }>;
    };
  };
  if (!meRes.ok || !postRes.ok || !me.data?.id || post.data?.author_id !== me.data.id || !post.data.text) return null;
  const media: ImportedMedia[] = (post.includes?.media ?? []).flatMap<ImportedMedia>((m) => {
    if (m.type === "photo" && m.url) {
      return [{ kind: "image" as const, url: m.url, mimeType: "image/jpeg", altText: m.alt_text }];
    }
    const variant = [...(m.variants ?? [])]
      .filter((v) => v.url && v.content_type === "video/mp4")
      .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
    const mediaUrl = variant?.url;
    return mediaUrl ? [{ kind: "video" as const, url: mediaUrl, mimeType: "video/mp4", altText: m.alt_text }] : [];
  });
  return { text: post.data.text, media };
}

/** Repurpose a specific owned X post, or the latest imported one, and carry its
 * native attachments into the staged LinkedIn schedule. */
export async function repurposeXPostToLinkedIn(userId: string, url?: string): Promise<RepurposeResult> {
  const row = await queryOne<CaptureRow>(
    url
      ? `SELECT id, raw_text, metadata FROM captures
         WHERE user_id = $1 AND source = 'x_import'
           AND (metadata->>'url' = $2 OR client_id = $3)
         ORDER BY captured_at DESC LIMIT 1`
      : `SELECT id, raw_text, metadata FROM captures
         WHERE user_id = $1 AND source = 'x_import'
           AND COALESCE(metadata->>'kind','') <> 'profile_bio'
           AND metadata->>'published' = 'true'
         ORDER BY captured_at DESC LIMIT 1`,
    url ? [userId, url, `x:${url}`] : [userId],
  );

  let sourceText = row?.raw_text?.trim() ?? "";
  let media = Array.isArray(row?.metadata?.media) ? row!.metadata.media! : [];
  const sourceUrl = url ?? row?.metadata?.url;
  if (sourceUrl && (!sourceText || media.length === 0)) {
    const live = await ownedXPost(userId, sourceUrl).catch(() => null);
    sourceText ||= live?.text ?? "";
    if (media.length === 0) media = live?.media ?? [];
  }
  if (!sourceText) {
    return {
      ok: false,
      output: "",
      notes: url
        ? "I couldn't find that post in your connected X history. Reconnect X or paste the post once so I can reshape it."
        : "I don't have an X post to repurpose yet. Connect X or paste one into Compose.",
    };
  }

  const mediaIds = media.length ? await stageRemoteMedia(userId, media).catch(() => []) : [];
  const result = await repurposeContent(userId, {
    mode: "cross_platform",
    target: "linkedin",
    sourceType: "published_post",
    sourceText,
    sourceIds: row ? [row.id] : [],
    mediaIds,
  });
  if (result.ok && media.length > 0 && mediaIds.length === 0) {
    result.notes = [result.notes, "I reshaped the text, but couldn't carry the source media into the schedule."].filter(Boolean).join(" ");
  }
  return result;
}
