import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES, type TranscribeJob } from "./boss.js";
import { transcribeAudio } from "../stt/transcribe.js";
import type { User } from "../lib/auth.js";
import { converseWithUser } from "../telegram/conversation.js";
import { deliverTurnOutput, chatToolExecutor } from "../telegram/actions.js";
import { dmChannel, withTyping } from "../telegram/bot.js";

/**
 * Voice captures store a Telegram file URL in audio_url. This job downloads the
 * audio, transcribes it, writes the transcript into the immutable capture's
 * raw_text (the one permitted enrichment), and hands off to extraction.
 *
 * For Telegram voice notes it then closes the conversational loop: the
 * transcript runs through the same chat brain as typed text and the reply is
 * DM'd back. Before this, a voice note was a dead end — "Got it, filing" —
 * so a question asked out loud was silently swallowed instead of answered.
 */
export async function handleTranscribe(job: TranscribeJob): Promise<void> {
  const capture = await queryOne<{ id: string; audio_url: string | null; source: string }>(
    `UPDATE captures SET status = 'transcribing' WHERE id = $1 RETURNING id, audio_url, source`,
    [job.captureId],
  );
  if (!capture?.audio_url) return;

  let text: string;
  try {
    const res = await fetch(capture.audio_url);
    if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    const out = await transcribeAudio(audio, "voice.oga", job.userId);
    text = out.text;
    await query(
      `UPDATE captures
       SET raw_text = $2, status = 'extracting',
           metadata = metadata || jsonb_build_object('stt_provider', $3::text)
       WHERE id = $1`,
      [capture.id, text, out.provider],
    );
    await getBoss().send(QUEUES.extract, { captureId: capture.id, userId: job.userId });
  } catch (err) {
    await query(`UPDATE captures SET status = 'failed' WHERE id = $1`, [capture.id]);
    throw err;
  }

  // Conversational close for voice notes. Best-effort: the capture pipeline
  // above already succeeded, so a failed reply must not fail (and retry) the
  // job — that would re-transcribe and re-extract the same capture.
  if (capture.source === "telegram_voice" && text.trim()) {
    try {
      const user = await queryOne<User>(`SELECT * FROM users WHERE id = $1`, [job.userId]);
      if (!user) return;
      const channel = dmChannel(job.userId);
      await withTyping(channel, async () => {
        const result = await converseWithUser(job.userId, text, { executeTool: chatToolExecutor(user, channel) });
        // The voice note is already a capture; suppress the brain's capture flag
        // so the thought isn't filed twice.
        await deliverTurnOutput(user, text, result, channel, { alreadyCaptured: true });
      });
    } catch (err) {
      console.error("voice-note conversational reply failed", err);
    }
  }
}
