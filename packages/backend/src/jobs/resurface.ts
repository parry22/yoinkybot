import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { composeResurfacing } from "../prompts/compose-resurfacing.v1.js";
import { pickBest, explainScore, type ScorableMemory } from "../surfacing/scoring.js";
import { inQuietHours, type UserSettings } from "../lib/time.js";
import { canDeliverProactive } from "../surfacing/cadence.js";
import { topPendingUnlock } from "../strategist/plan.js";
import { sendTelegram, resurfaceKeyboard } from "../telegram/bot.js";
import { createIdeaMoment } from "./offer-angles.js";
import { maybeOfferReplyDraft } from "../engagement/service.js";
import { decideColdStart, coldStartInputs, sendColdStartCheckin, maybeStructuralNudge } from "../surfacing/nudges.js";

const composedSchema = z.object({ message: z.string(), reasoning: z.string() });

/**
 * Plan-aware resurfacing: if the user has a confirmed plan with an undeveloped
 * unlock-list idea, nudge them on that (highest-priority first) instead of a
 * generic past memory. Records a 'resurface' surfacing so cadence stays shared.
 */
async function maybeResurfaceUnlock(userId: string, opts?: { coldStart?: boolean }): Promise<boolean> {
  const unlock = await topPendingUnlock(userId);
  if (!unlock) return false;

  const res = await llmCall({
    userId,
    eventType: "compose",
    tier: composeResurfacing.tier,
    system: composeResurfacing.system,
    user: composeResurfacing.render({
      memory: { content: unlock.idea, kind: "unlock", created_at: new Date().toISOString() },
      linked: [{ content: unlock.rationale, link_type: "why it matters for your plan" }],
      scoringReason: "this is a top idea on your unlock list you haven't turned into content yet",
    }),
    json: true,
    maxTokens: 512,
  });
  const composed = composedSchema.parse(res.parsed);

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'resurface', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ message: composed.message, reasoning: composed.reasoning, unlock_id: unlock.id, cold_start: opts?.coldStart ?? false })],
  );
  if (!surfacing) return false;

  // Angle-offering folds into resurfacing itself now (the old standalone hourly
  // scan had nothing left to scan since ambient capture was removed) - every
  // resurfaced idea gets its own moment so "turn into angles" is one tap away.
  const momentId = await createIdeaMoment(userId, unlock.idea, unlock.rationale || unlock.idea);
  const sent = await sendTelegram(userId, composed.message, surfacing.id, resurfaceKeyboard(surfacing.id, momentId));
  // A surfacing row is history AND a budget charge - don't keep one for a DM
  // that never landed.
  if (!sent) await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
  return sent;
}

/**
 * Cold-start fallback: reflect back the freshest real memory with genuine
 * observation, even though it wouldn't clear a normal competitive pass. Relaxed
 * on purpose - no 12h age gate, no scoring contest - because in this window a
 * modest real message beats an empty inbox.
 */
async function resurfaceFreshest(userId: string): Promise<boolean> {
  const memory = await queryOne<{ id: string; content: string; kind: string; created_at: string }>(
    `SELECT id, content, kind, created_at::text FROM memories
     WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL AND kind <> 'reaction'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!memory) return false;

  const res = await llmCall({
    userId,
    eventType: "compose",
    tier: composeResurfacing.tier,
    system: composeResurfacing.system,
    user: composeResurfacing.render({
      memory: { content: memory.content, kind: memory.kind, created_at: memory.created_at },
      linked: [],
      scoringReason:
        "their plan just went live and this is the freshest real thinking on file; the point is presence with substance, not a hard sell",
    }),
    json: true,
    maxTokens: 512,
  });
  const composed = composedSchema.parse(res.parsed);

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, ARRAY[$2]::uuid[], 'resurface', $3, 'telegram') RETURNING id`,
    [userId, memory.id, JSON.stringify({ message: composed.message, reasoning: composed.reasoning, cold_start: true })],
  );
  if (!surfacing) return false;

  const momentId = await createIdeaMoment(userId, memory.content, memory.content);
  const sent = await sendTelegram(userId, composed.message, surfacing.id, resurfaceKeyboard(surfacing.id, momentId));
  if (sent) {
    await query(`UPDATE memories SET last_surfaced_at = now(), surface_count = surface_count + 1 WHERE id = $1`, [memory.id]);
  } else {
    await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
  }
  return sent;
}

/**
 * Hourly tick over all Telegram-connected users. Selection is entirely
 * deterministic (scoring.ts); the frontier LLM only writes the message.
 */
export async function handleSurfaceTick(): Promise<void> {
  const users = await query<{ id: string; settings: UserSettings }>(
    `SELECT id, settings FROM users WHERE telegram_id IS NOT NULL`,
  );
  for (const user of users) {
    try {
      await maybeResurfaceUser(user.id, user.settings ?? {});
    } catch (err) {
      console.error(`resurface failed for user ${user.id}`, err);
    }
  }
}

export async function maybeResurfaceUser(userId: string, settings: UserSettings): Promise<boolean> {
  const now = new Date();

  // COLD START - the mandatory first touch. If the plan went live and the user
  // has heard nothing since, silence is never the answer in this window: find
  // the most interesting thing available, however modest, and send it. Exempt
  // from the weekly budget (it IS the minimum viable presence, not a bonus),
  // but quiet hours still hold.
  if (!inQuietHours(settings, now) && decideColdStart(await coldStartInputs(userId, now.getTime()))) {
    // Ladder: an undeveloped unlock item however thin → freshest real memory,
    // even if it wouldn't win a competitive pass → an honest check-in.
    if (await maybeResurfaceUnlock(userId, { coldStart: true })) return true;
    if (await resurfaceFreshest(userId)) return true;
    return sendColdStartCheckin(userId);
  }

  const cadence = await canDeliverProactive(userId, settings, now);
  if (!cadence.ok) return false;

  // The slot's priority function, explicit rather than cron-order accident:
  // a reply-worthy mention (substantive challenges first, then questions -
  // ordered inside maybeOfferReplyDraft) beats everything else time-sensitive,
  // then the plan's own unlock nudges, then generic resurfacing as steady state,
  // then a structural nudge before concluding there's genuinely nothing.
  if (await maybeOfferReplyDraft(userId)) return true;

  // Plan-aware: an undeveloped unlock-list idea outranks generic resurfacing.
  if (await maybeResurfaceUnlock(userId)) return true;

  const candidates = await query<{
    id: string;
    content: string;
    kind: string;
    created_at: string;
    last_surfaced_at: string | null;
    surface_count: number;
    link_count: string;
    reaction_net: string;
  }>(
    `SELECT m.id, m.content, m.kind, m.created_at::text, m.last_surfaced_at::text AS last_surfaced_at, m.surface_count,
            (SELECT count(*) FROM memory_links l WHERE l.memory_a = m.id OR l.memory_b = m.id)::text AS link_count,
            COALESCE((
              SELECT sum(CASE s.user_reaction WHEN 'fire' THEN 1 WHEN 'later' THEN -1 ELSE 0 END)
              FROM surfacings s WHERE s.user_id = m.user_id AND m.id = ANY(s.memory_ids)
            ), 0)::text AS reaction_net
     FROM memories m
     WHERE m.user_id = $1 AND m.status = 'active' AND m.embedding IS NOT NULL
       AND m.kind <> 'reaction'
       AND m.created_at < now() - interval '12 hours'`,
    [userId],
  );
  // No eligible memory → check for a structural stall worth naming before
  // concluding there's genuinely nothing. Silence should be a considered
  // outcome, not the default for "nothing obviously fired".
  if (candidates.length === 0) return maybeStructuralNudge(userId);

  const scorables: ScorableMemory[] = candidates.map((c) => ({
    id: c.id,
    createdAt: new Date(c.created_at).getTime(),
    lastSurfacedAt: c.last_surfaced_at ? new Date(c.last_surfaced_at).getTime() : null,
    surfaceCount: c.surface_count,
    linkCount: Number(c.link_count),
    reactionNet: Number(c.reaction_net),
  }));
  const best = pickBest(scorables, now.getTime());
  if (!best) return maybeStructuralNudge(userId);
  const memory = candidates.find((c) => c.id === best.id)!;

  const linked = await query<{ content: string; link_type: string }>(
    `SELECT m2.content, l.link_type
     FROM memory_links l
     JOIN memories m2 ON m2.id = CASE WHEN l.memory_a = $1 THEN l.memory_b ELSE l.memory_a END
     WHERE (l.memory_a = $1 OR l.memory_b = $1) AND m2.status = 'active'
     ORDER BY l.strength DESC
     LIMIT 4`,
    [memory.id],
  );

  const scoringReason = explainScore(best, now.getTime());
  const res = await llmCall({
    userId,
    eventType: "compose",
    tier: composeResurfacing.tier,
    system: composeResurfacing.system,
    user: composeResurfacing.render({
      memory: { content: memory.content, kind: memory.kind, created_at: memory.created_at },
      linked,
      scoringReason,
    }),
    json: true,
    maxTokens: 512,
  });
  const composed = composedSchema.parse(res.parsed);

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, ARRAY[$2]::uuid[], 'resurface', $3, 'telegram') RETURNING id`,
    [userId, memory.id, JSON.stringify({ message: composed.message, reasoning: composed.reasoning, scoring: scoringReason })],
  );
  if (!surfacing) return false;

  const momentId = await createIdeaMoment(userId, memory.content, memory.content);
  const sent = await sendTelegram(userId, composed.message, surfacing.id, resurfaceKeyboard(surfacing.id, momentId));
  if (sent) {
    await query(
      `UPDATE memories SET last_surfaced_at = now(), surface_count = surface_count + 1 WHERE id = $1`,
      [memory.id],
    );
  } else {
    await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
  }
  return sent;
}
