import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { converse } from "../prompts/converse.v1.js";
import { activePositions } from "../memory/positions.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getPlan } from "../strategist/plan.js";
import { activeGoals } from "../strategist/goals.js";
import { getStage } from "../strategist/state.js";

const HISTORY_TURNS = 10;

const replySchema = z.object({
  reply: z.string().min(1),
  capture: z.boolean().default(false),
  offer_angles: z.boolean().default(false),
});

export interface ConversationResult {
  reply: string;
  capture: boolean;
  offerAngles: boolean;
}

async function loadHistory(userId: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, HISTORY_TURNS],
  );
  return rows.reverse();
}

/**
 * The working relationship, computed from facts rather than model-written notes:
 * what's been nudged and ignored, how they respond to drafts, how they've been
 * reacting lately. This is what separates a strategist who's been in the room
 * for weeks from a smart stranger — and none of it needs new storage.
 */
export async function relationshipContext(userId: string): Promise<string | null> {
  const [ignoredUnlocks, replyStats, reactions] = await Promise.all([
    query<{ idea: string; nudges: string }>(
      `SELECT ui.idea, count(s.id)::text AS nudges
       FROM unlock_items ui
       JOIN surfacings s ON s.user_id = ui.user_id AND s.type = 'resurface'
         AND s.payload->>'unlock_id' = ui.id::text
       WHERE ui.user_id = $1 AND ui.status = 'pending'
       GROUP BY ui.idea HAVING count(s.id) >= 2`,
      [userId],
    ),
    queryOne<{ skipped: string; sent: string; edited: string }>(
      `SELECT
         (SELECT count(*) FROM mentions WHERE user_id = $1 AND reply_status = 'skipped')::text AS skipped,
         (SELECT count(*) FROM sent_replies WHERE user_id = $1)::text AS sent,
         (SELECT count(*) FROM sent_replies WHERE user_id = $1 AND edited_before_send)::text AS edited`,
      [userId],
    ),
    queryOne<{ fire: string; later: string }>(
      `SELECT
         count(*) FILTER (WHERE user_reaction = 'fire')::text AS fire,
         count(*) FILTER (WHERE user_reaction = 'later')::text AS later
       FROM surfacings WHERE user_id = $1 AND delivered_at > now() - interval '30 days'`,
      [userId],
    ),
  ]);

  const lines: string[] = [];
  if (ignoredUnlocks.length) {
    lines.push(
      `Ideas you've nudged 2+ times that they still haven't written: ${ignoredUnlocks.map((u) => `"${u.idea}"`).join("; ")} — there may be a real reason; worth asking, not re-nudging.`,
    );
  }
  const sent = Number(replyStats?.sent ?? 0);
  const skipped = Number(replyStats?.skipped ?? 0);
  const edited = Number(replyStats?.edited ?? 0);
  if (sent + skipped >= 3) {
    lines.push(
      `Reply drafts: ${sent} sent (${edited} reworked first), ${skipped} skipped${
        sent > 0 && edited / sent > 0.6 ? " — they usually rewrite your drafts, so voice-match is off somewhere" : ""
      }.`,
    );
  }
  const fire = Number(reactions?.fire ?? 0);
  const later = Number(reactions?.later ?? 0);
  if (fire + later >= 3) {
    lines.push(`Recent reactions to what you bring: ${fire}x useful, ${later}x "not now"${later > fire ? " — dial the proactive instinct down, sharpen relevance" : ""}.`);
  }
  return lines.length ? lines.join("\n") : null;
}

export async function saveTurn(userId: string, role: "user" | "assistant", content: string): Promise<void> {
  await query(`INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)`, [userId, role, content]);
}

/**
 * The full conversational turn: gather everything Yoinky knows about the user,
 * let the strategist prompt reason over it, persist the exchange, and return the
 * reply plus what to do with the message (file it / offer angles).
 */
export async function converseWithUser(userId: string, message: string): Promise<ConversationResult> {
  const [history, positions, relevant, profile, moments, pending, counts, relationship] = await Promise.all([
    loadHistory(userId),
    activePositions(userId),
    hybridSearch(userId, message, 6).catch(() => []),
    currentVoiceProfile(userId),
    query<{ title: string | null; theme: string | null; verdict: string }>(
      `SELECT title, signals->>'theme' AS theme, verdict FROM moments
       WHERE user_id = $1 AND verdict IN ('shareable','angled') ORDER BY created_at DESC LIMIT 5`,
      [userId],
    ),
    query<{ payload: { title?: string; angles?: Array<{ hook: string }> } }>(
      `SELECT payload FROM surfacings
       WHERE user_id = $1 AND type IN ('angle_offer','trend_match') AND user_reaction IS NULL
       ORDER BY delivered_at DESC LIMIT 3`,
      [userId],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM memories WHERE user_id = $1 AND status = 'active'`, [userId]),
    relationshipContext(userId).catch(() => null),
  ]);

  // Plan context (throughline, goal, undeveloped unlocks, onboarding stage).
  const [plan, goals, stage] = await Promise.all([
    getPlan(userId).catch(() => null),
    activeGoals(userId).catch(() => []),
    getStage(userId).catch(() => "new"),
  ]);
  const pendingUnlocks = (plan?.unlock ?? []).filter((u) => u.status === "pending").map((u) => u.idea);

  const res = await llmCall({
    userId,
    eventType: "converse",
    tier: converse.tier,
    system: converse.system,
    user: converse.render({
      message,
      history,
      positions: positions.map((p) => p.statement),
      relevantMemories: relevant.map((m) => ({ content: m.content, kind: m.kind, created_at: m.created_at })),
      recentMoments: moments.map((m) => ({ title: m.title ?? "(untitled)", theme: m.theme, verdict: m.verdict })),
      pendingAngles: pending.map((p) => ({
        title: p.payload?.title ?? "a saved moment",
        hooks: (p.payload?.angles ?? []).map((a) => a.hook).slice(0, 3),
      })),
      voiceTraits: profile?.traits,
      memoryCount: Number(counts[0]?.n ?? 0),
      throughline: plan?.throughline,
      goal: goals[0]?.detail,
      pendingUnlocks,
      stage,
      relationship,
    }),
    json: true,
    maxTokens: 600,
  });
  const parsed = replySchema.parse(res.parsed);

  await saveTurn(userId, "user", message);
  await saveTurn(userId, "assistant", parsed.reply);

  return { reply: parsed.reply, capture: parsed.capture, offerAngles: parsed.offer_angles };
}
