import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES, type TranscribeJob } from "./boss.js";
import { transcribeAudio } from "../stt/transcribe.js";

/**
 * Voice captures store a Telegram file URL in audio_url. This job downloads the
 * audio, transcribes it, writes the transcript into the immutable capture's
 * raw_text (the one permitted enrichment), and hands off to extraction.
 */
export async function handleTranscribe(job: TranscribeJob): Promise<void> {
  const capture = await queryOne<{ id: string; audio_url: string | null; status: string }>(
    `UPDATE captures SET status = 'transcribing' WHERE id = $1 RETURNING id, audio_url, status`,
    [job.captureId],
  );
  if (!capture?.audio_url) return;

  try {
    const res = await fetch(capture.audio_url);
    if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    const { text, provider } = await transcribeAudio(audio, "voice.oga", job.userId);
    await query(
      `UPDATE captures
       SET raw_text = $2, status = 'extracting',
           metadata = metadata || jsonb_build_object('stt_provider', $3::text)
       WHERE id = $1`,
      [capture.id, text, provider],
    );
    await getBoss().send(QUEUES.extract, { captureId: capture.id, userId: job.userId });
  } catch (err) {
    await query(`UPDATE captures SET status = 'failed' WHERE id = $1`, [capture.id]);
    throw err;
  }
}
