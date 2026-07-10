import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES, type ExtractJob } from "./boss.js";
import { llmCall } from "../llm/gateway.js";
import { extractMemories } from "../prompts/extract-memories.v1.js";
import { upsertPosition } from "../memory/positions.js";
import { sendTelegram } from "../telegram/bot.js";

const extractionSchema = z.object({
  memories: z.array(
    z.object({
      content: z.string().min(1),
      kind: z.enum(["idea", "claim", "question", "story", "reaction"]),
      // Tolerate a missing/garbled orientation from the cheap model rather than
      // failing the whole capture — 'neutral' just drops it from the ratio.
      orientation: z.enum(["inside_out", "outside_in", "neutral"]).catch("neutral").default("neutral"),
    }),
  ),
  positions: z.array(z.string()).default([]),
});

/**
 * capture → memory units. One capture can yield several memories (multi-idea
 * splitting), each individually classified; explicit beliefs land in positions.
 */
export async function handleExtract(job: ExtractJob): Promise<void> {
  const capture = await queryOne<{ id: string; raw_text: string | null; source: string; captured_at: string; status: string }>(
    `SELECT id, raw_text, source, captured_at::text, status FROM captures WHERE id = $1`,
    [job.captureId],
  );
  if (!capture) return;
  // Idempotency: a job re-run after this capture already completed must be a
  // no-op — otherwise a pg-boss retry double-inserts memories, re-fires belief
  // DMs, and double-charges LLM spend.
  if (capture.status === "processed") return;
  if (!capture.raw_text?.trim()) {
    await query(`UPDATE captures SET status = 'failed' WHERE id = $1`, [job.captureId]);
    return;
  }

  try {
    // Clear any memories from a prior partial attempt on THIS capture so a retry
    // rebuilds cleanly instead of stacking duplicates (cascades memory_links).
    await query(`DELETE FROM memories WHERE capture_id = $1`, [capture.id]);
    const res = await llmCall({
      userId: job.userId,
      eventType: "extract",
      tier: extractMemories.tier,
      system: extractMemories.system,
      user: extractMemories.render({ text: capture.raw_text, source: capture.source }),
      json: true,
      maxTokens: 2048,
    });
    const parsed = extractionSchema.parse(res.parsed);

    const memoryIds: string[] = [];
    for (const m of parsed.memories) {
      // Memories inherit the capture's timestamp — for imported posts that's the
      // original publish date, which is what makes every time-based read real
      // (recurrence across periods, voice drift, chronological diagnosis).
      const row = await queryOne<{ id: string }>(
        `INSERT INTO memories (user_id, profile_id, capture_id, content, kind, orientation, created_at)
         VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
        [job.userId, capture.id, m.content, m.kind, m.orientation, capture.captured_at],
      );
      if (row) {
        memoryIds.push(row.id);
        await getBoss().send(QUEUES.embedLink, { memoryId: row.id, userId: job.userId });
      }
    }

    // Positions need a source memory; anchor each to the first extracted memory.
    const anchor = memoryIds[0];
    const supersessions: Array<{ now: string; before: string[] }> = [];
    if (anchor) {
      for (const statement of parsed.positions) {
        const change = await upsertPosition(job.userId, statement, anchor);
        if (change.action === "superseded" && change.replaced.length) {
          supersessions.push({ now: change.position.statement, before: change.replaced });
        }
      }
    }

    // Mark terminal BEFORE any user-facing DM: if the DM (or a later step) fails
    // and the job retries, the status guard above short-circuits it, so the
    // belief-change message is sent at most once.
    await query(`UPDATE captures SET status = 'processed' WHERE id = $1`, [capture.id]);

    // A belief flipped during LIVE conversation → tell them, transparently.
    // Bulk imports reconcile silently (200 posts of history would be noise).
    if (supersessions.length && (capture.source === "telegram_text" || capture.source === "telegram_voice")) {
      const lines = supersessions.map(
        (s) => `"${s.before.join('" and "')}" is now "${s.now}"`,
      );
      await sendTelegram(
        job.userId,
        `Updated what I believe you think. ${lines.join(". ")}. The old version stays in your history, say the word if I read that wrong.`,
      ).catch(() => {});
    }
  } catch (err) {
    await query(`UPDATE captures SET status = 'failed' WHERE id = $1`, [capture.id]);
    throw err;
  }
}
