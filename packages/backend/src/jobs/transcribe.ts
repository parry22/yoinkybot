import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES, type TranscribeJob } from "./boss.js";
import { transcribeAudio } from "../stt/transcribe.js";
import type { User } from "../lib/auth.js";
import { converseWithUser } from "../telegram/conversation.js";
import { deliverTurnOutput, chatToolExecutor } from "../telegram/actions.js";
import { dmChannel, withTyping } from "../telegram/bot.js";
import { runAsUser } from "../byok/context.js";
import { isByokUser } from "../byok/keys.js";
import { extractTranscriptToKnowledge } from "../knowledge/service.js";

/**
 * Voice captures store a Telegram file URL in audio_url. This job downloads the
 * audio, transcribes it, writes the transcript into the immutable capture's
 * raw_text (the one permitted enrichment), and hands off to extraction.
 *
 * For Telegram voice notes it then closes the conversational loop: the
 * transcript runs through the same chat brain as typed text and the reply is
 * DM'd back. Before this, a voice note was a dead end - "Got it, filing" -
 * so a question asked out loud was silently swallowed instead of answered.
 */
export async function handleTranscribe(job: TranscribeJob): Promise<void> {
  const capture = await queryOne<{ id: string; audio_url: string | null; source: string;workspace_id:string|null;speaker_expert_id:string|null;permission_level:"public"|"internal"|"restricted"|"confidential"|"never_use_for_generation";metadata:Record<string,unknown> }>(
    `UPDATE captures SET status = 'transcribing' WHERE id = $1 RETURNING id, audio_url, source,workspace_id,speaker_expert_id,permission_level,metadata`,
    [job.captureId],
  );
  if (!capture?.audio_url) return;

  let text: string;
  try {
    // Lifetime BYOK covers model and scraper traffic, not speech vendors. Do
    // not quietly make an unlimited voice feature an owner-paid liability.
    if (await isByokUser(job.userId)) {
      throw new Error("Voice transcription is not available on Lifetime BYOK yet. Send this thought as text instead.");
    }
    // SSRF guard + defensive depth: audio_url is always server-built to
    // api.telegram.org today, but this fetch is one code change away from
    // pulling an attacker-controlled URL into the server's network. Pin the host
    // and add a hard timeout so it can't be turned into an internal-network probe
    // or a hang. HTTPS + telegram host only.
    const parsed = new URL(capture.audio_url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.telegram.org") {
      throw new Error(`refused audio host: ${parsed.hostname}`);
    }
    const res = await fetch(capture.audio_url, { signal: AbortSignal.timeout(30_000) });
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
    const company=capture.workspace_id?await queryOne<{workspace_type:string;name:string}>(`SELECT workspace_type,name FROM workspaces WHERE id=$1`,[capture.workspace_id]):null;
    if(capture.workspace_id&&company?.workspace_type==="company"){
      await extractTranscriptToKnowledge(job.userId,capture.workspace_id,{existingCaptureId:capture.id,title:typeof capture.metadata.title==="string"?capture.metadata.title:`Voice note, ${new Date().toISOString().slice(0,10)}`,transcript:text,sourceType:"voice_note",speakerExpertId:capture.speaker_expert_id,permissionLevel:capture.permission_level});
    }else{
      await getBoss().send(QUEUES.extract, { captureId: capture.id, userId: job.userId });
    }
  } catch (err) {
    await query(`UPDATE captures SET status = 'failed' WHERE id = $1`, [capture.id]);
    throw err;
  }

  // Conversational close for voice notes. Best-effort: the capture pipeline
  // above already succeeded, so a failed reply must not fail (and retry) the
  // job - that would re-transcribe and re-extract the same capture.
  if (capture.source === "telegram_voice" && text.trim()) {
    try {
      const user = await queryOne<User>(`SELECT * FROM users WHERE id = $1`, [job.userId]);
      if (!user) return;
      const channel = dmChannel(job.userId);
      await withTyping(channel, async () => {
        // Tool calls triggered by a voice reply can search or scrape. Re-enter
        // the owner context just like typed Telegram turns do.
        const result = await runAsUser(job.userId, () =>
          converseWithUser(job.userId, text, { executeTool: chatToolExecutor(user, channel) }),
        );
        // The voice note is already a capture; suppress the brain's capture flag
        // so the thought isn't filed twice.
        await deliverTurnOutput(user, text, result, channel, { alreadyCaptured: true });
      });
    } catch (err) {
      console.error("voice-note conversational reply failed", err);
    }
  }
}
