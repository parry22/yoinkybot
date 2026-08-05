import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { deleteCleanedMediaRecord, mediaBlobCleanupCandidates } from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily Blob cleanup. Vercel Cron sends CRON_SECRET as a bearer token. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const candidates = await mediaBlobCleanupCandidates();
  let deleted = 0;
  for (const item of candidates) {
    try {
      await del(item.url);
      await deleteCleanedMediaRecord(item.id);
      deleted++;
    } catch (err) {
      // Leave the row in place for tomorrow's retry. One missing Blob must not
      // prevent the rest of the batch from being reclaimed.
      console.error("media cleanup failed", item.id, err);
    }
  }
  return NextResponse.json({ ok: true, examined: candidates.length, deleted });
}
