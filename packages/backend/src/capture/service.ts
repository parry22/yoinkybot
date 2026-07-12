import { queryOne } from "../db/pool.js";
import { getBoss, QUEUES } from "../jobs/boss.js";
import { track } from "../analytics/posthog.js";

export type CaptureSource =
  | "telegram_voice"
  | "telegram_text"
  | "x_import"
  | "linkedin_import";

export interface Capture {
  id: string;
  user_id: string;
  source: CaptureSource;
  raw_text: string | null;
  audio_url: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
  status: string;
}

export interface CreateCaptureInput {
  userId: string;
  source: CaptureSource;
  rawText?: string;
  audioUrl?: string;
  capturedAt?: Date;
  metadata?: Record<string, unknown>;
  /** Idempotency key for batched ambient capture; dupes return the existing row. */
  clientId?: string;
  /** Skip queueing (bulk imports and moment intake enqueue their own jobs). */
  enqueue?: boolean;
}

function initialStatus(input: CreateCaptureInput): string {
  if (input.audioUrl) return "pending";
  return "extracting";
}

/**
 * Captures are immutable raw inputs — never updated except for pipeline status.
 * Returns { capture, created:false } when a clientId dedupes to an existing row.
 */
export async function createCapture(
  input: CreateCaptureInput,
): Promise<{ capture: Capture; created: boolean }> {
  const inserted = (await queryOne(
    `INSERT INTO captures (user_id, source, raw_text, audio_url, captured_at, metadata, status, client_id)
     VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6,$7,$8)
     ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      input.userId,
      input.source,
      input.rawText ?? null,
      input.audioUrl ?? null,
      input.capturedAt ?? null,
      JSON.stringify(input.metadata ?? {}),
      initialStatus(input),
      input.clientId ?? null,
    ],
  )) as unknown as Capture | undefined;

  if (!inserted) {
    // Dupe (same user_id + client_id) — return the existing capture, don't re-enqueue.
    const existing = (await queryOne(
      `SELECT * FROM captures WHERE user_id = $1 AND client_id = $2`,
      [input.userId, input.clientId],
    )) as unknown as Capture;
    return { capture: existing, created: false };
  }

  if (input.enqueue !== false) {
    const boss = getBoss();
    if (input.audioUrl) {
      await boss.send(QUEUES.transcribe, { captureId: inserted.id, userId: input.userId });
    } else {
      await boss.send(QUEUES.extract, { captureId: inserted.id, userId: input.userId });
    }
  }
  // Only the user's own dropped thoughts are an activation signal — the bulk
  // x_import/linkedin_import rows during connect would drown that out, so track
  // just the telegram-authored captures (no raw text — metadata only).
  if (input.source === "telegram_text" || input.source === "telegram_voice") {
    track(input.userId, "capture_created", { source: input.source });
  }
  return { capture: inserted, created: true };
}
