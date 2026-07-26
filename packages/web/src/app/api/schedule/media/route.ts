import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { getSessionUser } from "@/lib/session";
import { requirePaid } from "@/lib/entitlements";
import { stageMedia, discardStagedMedia, ACCEPTED_MEDIA_TYPES, MEDIA_LIMITS } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A 200MB video upload plus the round-trip to Blob needs more than the default.
export const maxDuration = 300;

/**
 * Upload one attachment for a scheduled post.
 *
 * The bytes go to Vercel Blob from HERE, not from the browser and not from the
 * Railway backend: this route is the only place holding BLOB_READ_WRITE_TOKEN. The
 * stored URL is public (unguessable pathname suffix), which is what lets the
 * publisher on Railway fetch it later with a plain GET and no storage credential —
 * see backend social/media.ts.
 *
 * The upload is STAGED, not attached: the post row doesn't exist yet (the user is
 * still typing), so the media row carries a NULL scheduled_post_id until
 * `/api/schedule` binds it on save.
 *
 * Vercel Functions accept request bodies up to 100MB, so anything above that has
 * to be rejected here even though X itself would take a larger video.
 */
const MAX_REQUEST_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requirePaid(user))) return NextResponse.json({ error: "upgrade_required" }, { status: 402 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "that upload didn't come through — try again" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no file attached" }, { status: 400 });
  const altText = typeof form.get("altText") === "string" ? String(form.get("altText")) : undefined;

  if (file.size <= 0) return NextResponse.json({ error: "that file is empty" }, { status: 400 });
  if (file.size > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      { error: `that file is too big to upload through the browser — keep it under ${MAX_REQUEST_BYTES / (1024 * 1024)}MB` },
      { status: 413 },
    );
  }
  // Cheap pre-check so an unsupported type never reaches storage. stageMedia
  // re-checks against the same table the publisher uses, which is authoritative.
  if (!ACCEPTED_MEDIA_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `${file.type || "that format"} isn't supported — use JPEG, PNG, WebP, GIF or MP4` },
      { status: 400 },
    );
  }

  // Namespaced by user so one person's uploads are never in another's prefix.
  // addRandomSuffix keeps the public URL unguessable and stops same-name collisions.
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "upload";
  let blob: Awaited<ReturnType<typeof put>>;
  try {
    blob = await put(`scheduled/${user.id}/${safeName}`, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type,
    });
  } catch (err) {
    console.error("blob upload failed", err);
    return NextResponse.json({ error: "couldn't store that file — try again" }, { status: 502 });
  }

  const staged = await stageMedia(user.id, {
    url: blob.url,
    blobPath: blob.pathname,
    mimeType: file.type,
    byteSize: file.size,
    altText,
  });
  if (!staged.ok || !staged.media) {
    // Don't leave an orphan in storage when the row was refused.
    await del(blob.url).catch(() => {});
    return NextResponse.json({ error: staged.reason ?? "couldn't attach that" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, media: staged.media, limits: MEDIA_LIMITS });
}

/** Remove a staged attachment the user took back off the post before saving. */
export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; url?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const res = await discardStagedMedia(user.id, id);
  // Best-effort storage cleanup; the row is the source of truth either way.
  if (res.ok && typeof body.url === "string" && body.url) await del(body.url).catch(() => {});
  return NextResponse.json(res, { status: res.ok ? 200 : 404 });
}
