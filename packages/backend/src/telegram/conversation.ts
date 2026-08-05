import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";
import { llmCall, asObject, hashForCacheKey } from "../llm/gateway.js";
import { converse } from "../prompts/converse.v3.js";
import { parseChatTool, chatToolSchema, type ChatTool } from "./chat-tools.js";
import { runAgentChatTurn } from "../agent-runtime/chat-turn.js";
import { sdkConfigured } from "../agent-runtime/sdk-options.js";
import { activePositions } from "../memory/positions.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getPlan } from "../strategist/plan.js";
import { activeGoals } from "../strategist/goals.js";
import { getStage } from "../strategist/state.js";
import { getProfile, profileSummaryForPrompt } from "../strategist/profile.js";
import { casualize } from "../prompts/style.js";
import { moderateText, MODERATION_MESSAGE } from "../moderation/filter.js";

const HISTORY_TURNS = 10;

const replySchema = z.object({
  // Empty is legal when a tool call carries the whole turn (e.g. search_memory).
  reply: z.string().default(""),
  capture: z.boolean().default(false),
  offer_angles: z.boolean().default(false),
  tool: z.unknown().nullish(),
});

export interface ConversationResult {
  reply: string;
  capture: boolean;
  offerAngles: boolean;
  /** A tool the brain decided to call this turn; executed by telegram/actions.ts.
   *  Only set on the legacy single-tool path (no executor passed) - with an
   *  executor, tools run inside the turn loop and this stays undefined. */
  tool?: ChatTool;
}

export interface ConverseOpts {
  /**
   * Runs one mid-turn tool call (delivering its output to the user) and returns
   * the compact trace fed back to the model. Passing this turns the turn into a
   * bounded multi-tool loop (up to MAX_TOOL_CALLS_PER_TURN); without it, the
   * first tool call ends the turn and is returned for the caller to execute
   * (the legacy single-tool behavior). Both live callers - typed text
   * (bot.ts) and voice transcript (transcribe.ts) - pass an executor, so the
   * single-tool branch is a preserved fallback, not a currently-exercised path;
   * paced onboarding runs through runSessionTurn (session-machine), not here.
   */
  executeTool?: (tool: ChatTool, replyBeat: string) => Promise<string>;
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
 * for weeks from a smart stranger - and none of it needs new storage.
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
      `Ideas you've nudged 2+ times that they still haven't written: ${ignoredUnlocks.map((u) => `"${u.idea}"`).join("; ")} - there may be a real reason; worth asking, not re-nudging.`,
    );
  }
  const sent = Number(replyStats?.sent ?? 0);
  const skipped = Number(replyStats?.skipped ?? 0);
  const edited = Number(replyStats?.edited ?? 0);
  if (sent + skipped >= 3) {
    lines.push(
      `Reply drafts: ${sent} sent (${edited} reworked first), ${skipped} skipped${
        sent > 0 && edited / sent > 0.6 ? " - they usually rewrite your drafts, so voice-match is off somewhere" : ""
      }.`,
    );
  }
  const fire = Number(reactions?.fire ?? 0);
  const later = Number(reactions?.later ?? 0);
  if (fire + later >= 3) {
    lines.push(`Recent reactions to what you bring: ${fire}x useful, ${later}x "not now"${later > fire ? " - dial the proactive instinct down, sharpen relevance" : ""}.`);
  }
  return lines.length ? lines.join("\n") : null;
}

export async function saveTurn(userId: string, role: "user" | "assistant", content: string): Promise<void> {
  await query(`INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)`, [userId, role, content]);
}

/**
 * The full conversational turn: gather everything Yoinky knows about the user,
 * let the strategist prompt reason over it, persist the exchange, and return the
 * final reply plus what to do with the message (file it / offer angles).
 *
 * With opts.executeTool set, this is a bounded agent loop (converse.v3): the
 * model may chain up to MAX_TOOL_CALLS_PER_TURN tool calls, each executed
 * immediately and fed back as a compact note - full raw payloads stay out of
 * the loop's own context. Guardrails: hard call cap, and the same tool with the
 * same args twice in one turn is rejected and forces a final reply.
 */
export async function converseWithUser(
  userId: string,
  message: string,
  opts: ConverseOpts = {},
): Promise<ConversationResult> {
  // Content gate before anything else: explicit/abusive input is pushed back and
  // never persisted, embedded, or fed to the model. Covers Telegram, web chat,
  // and voice transcripts, since all three converge here.
  if (!moderateText(message).ok) {
    return { reply: casualize(MODERATION_MESSAGE), capture: false, offerAngles: false };
  }

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

  // Plan context (throughline, goal, undeveloped unlocks, onboarding stage) + the
  // stated brand profile, so steady-state chat reasons against what they told us.
  const [plan, goals, stage, brandProfile] = await Promise.all([
    getPlan(userId).catch(() => null),
    activeGoals(userId).catch(() => []),
    getStage(userId).catch(() => "new"),
    getProfile(userId).catch(() => null),
  ]);
  const pendingUnlocks = (plan?.unlock ?? []).filter((u) => u.status === "pending").map((u) => u.idea);

  const maxToolCalls = opts.executeTool ? config.MAX_TOOL_CALLS_PER_TURN : 1;
  const toolNotes: string[] = [];
  const seenCalls = new Set<string>();
  // Cache affinity (spec §3): all iterations of THIS turn carry one key, so the
  // whole multi-tool turn lands on one server and iterations 2-N replay a warm
  // prefix. `now` is computed ONCE here (not per iteration) so the front of the
  // user message is byte-identical across the turn's iterations - only the
  // appended tool notes at the tail change (spec §2/§6 prefix stability).
  //
  // The key is STABLE PER USER PER DAY. It used to end in `randomUUID()`, which
  // held affinity inside one turn and threw it away between turns - a new key
  // every turn means a new upstream server and a cold prefix, so the ~5.7k-token
  // stable header (persona, profile, throughline, positions) was re-billed at the
  // full input rate on every single turn. That is the single biggest reason the
  // measured cache hit rate was 2.8%. Chat is ~95% input by volume and a cached
  // Grok token is 6.7x cheaper, so this one line is most of the caching win.
  //
  // Dated rather than permanent so affinity still rebalances across servers daily,
  // and so a user whose stable context changed materially isn't pinned forever to
  // a node holding a stale prefix.
  const cacheKey = `chat:${hashForCacheKey(userId)}:${new Date().toISOString().slice(0, 10)}`;
  const nowIso = new Date().toISOString();
  let forceFinal = false;
  let userTurnSaved = false;
  // The user's message is assessed on the first pass; later passes only digest
  // tool results, so the capture/offer_angles flags from pass one stand.
  let capture = false;
  let offerAngles = false;

  /** One renderer for both runtimes, so the SDK path and the legacy loop can
   *  never drift apart on what the model is actually shown. */
  const renderUser = (notes: string[]) =>
    converse.render({
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
      profile: brandProfile ? profileSummaryForPrompt(brandProfile) : undefined,
      throughline: plan?.throughline,
      goal: goals[0]?.detail,
      pendingUnlocks,
      stage,
      relationship,
      toolNotes: notes,
      toolCallsRemaining: Math.max(0, maxToolCalls - notes.length),
      now: nowIso,
    });

  // ── Agent SDK path (docs/INTERNAL §3n) ──────────────────────────────────────
  // Only with an executor: without one the caller wants the legacy single-tool
  // behaviour (first tool call ends the turn and is handed back), which has no
  // SDK equivalent because the SDK runs tools itself.
  if (config.AGENT_RUNTIME_CHAT === "sdk" && opts.executeTool && sdkConfigured()) {
    // The user's message is persisted BEFORE the run, unlike the legacy loop
    // which waits for a successful first model call. It has to be: the SDK may
    // execute a tool - and the executor persists its beat and trace as assistant
    // turns - before we ever see a result, and a reply landing in history ahead
    // of the message that prompted it would corrupt the transcript order.
    await saveTurn(userId, "user", message);
    userTurnSaved = true;
    try {
      const turn = await runAgentChatTurn({
        userId,
        system: converse.system,
        user: renderUser([]),
        maxToolCalls,
        toolSchema: chatToolSchema,
        executeTool: (tool, beat) => opts.executeTool!(tool as ChatTool, casualize(beat)),
      });
      const reply = casualize(turn.reply);
      // Same rule as the legacy tail: a turn must carry something, but when a
      // tool already delivered output an empty final beat is correct, not a bug.
      const finalReply = reply || (turn.toolCalls > 0 ? "" : "Say more?");
      if (finalReply) await saveTurn(userId, "assistant", finalReply);
      return { reply: finalReply, capture: turn.capture, offerAngles: turn.offerAngles };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!config.AGENT_SDK_FALLBACK_TO_LEGACY) throw err;
      // Loud, never silent. Falls through to the legacy loop below; the user
      // turn is already saved, which `userTurnSaved` prevents duplicating.
      console.warn(`agent-runtime FALLBACK [chat] → legacy after sdk failure: ${why.slice(0, 300)}`);
    }
  }

  for (let call = 0; ; call++) {
    const outOfCalls = forceFinal || toolNotes.length >= maxToolCalls;
    const res = await llmCall({
      userId,
      eventType: "converse",
      tier: converse.tier,
      cacheKey,
      system: converse.system,
      user:
        renderUser(toolNotes) +
        (outOfCalls
          ? "\n\nNo more tool calls this turn. Give your final reply now (tool must be null)."
          : ""),
      json: true,
      maxTokens: 600,
    });
    // GLM sometimes wraps the object in an array ([{...}]); coerce before parse.
    const safe = replySchema.safeParse(asObject(res.parsed));
    if (!safe.success) {
      // Valid JSON, unusable shape. Don't crash the turn with a raw Zod dump -
      // degrade to a soft nudge. Anything a tool already ran this turn has
      // already reached the user; we just can't add a final beat.
      console.error("converse: unusable model output", {
        issues: safe.error.issues,
        raw: JSON.stringify(res.parsed).slice(0, 300),
      });
      if (!userTurnSaved) await saveTurn(userId, "user", message);
      return {
        reply: toolNotes.length ? "" : "hit a glitch there, mind saying that again?",
        capture,
        offerAngles,
      };
    }
    const parsed = safe.data;
    if (call === 0) {
      capture = parsed.capture;
      offerAngles = parsed.offer_angles;
      // First model call succeeded - the turn is real, persist their message
      // before any tool output lands so history stays chronological. Guarded:
      // when the SDK path ran first and fell back, it already saved this.
      if (!userTurnSaved) {
        await saveTurn(userId, "user", message);
        userTurnSaved = true;
      }
    }
    const tool = parseChatTool(parsed.tool);
    const reply = casualize(parsed.reply);

    // Legacy single-tool path: hand the tool back for the caller to execute.
    if (tool && !opts.executeTool) {
      if (reply) await saveTurn(userId, "assistant", reply);
      return { reply, capture, offerAngles, tool };
    }

    if (tool && opts.executeTool && !outOfCalls) {
      const key = JSON.stringify(tool);
      if (seenCalls.has(key)) {
        // Same tool + same args twice in one turn → reject, force a final reply.
        toolNotes.push(`(you already called ${tool.name} with those exact args this turn - answer with what you have)`);
        forceFinal = true;
        continue;
      }
      seenCalls.add(key);
      let trace: string;
      try {
        trace = await opts.executeTool(tool, reply);
      } catch (err) {
        console.error(`chat tool ${tool.name} failed mid-turn`, err);
        trace = "tool failed on our end - tell them plainly and carry on without it";
      }
      toolNotes.push(`${tool.name}(${JSON.stringify({ ...tool, name: undefined })}) → ${trace.slice(0, 700)}`);
      continue;
    }

    // Final pass (no tool, or the model asked past the cap - the ask is dropped).
    // A turn must carry something: with no tool run and no reply, degrade to a
    // nudge rather than silence.
    const finalReply = reply || (toolNotes.length > 0 ? "" : "Say more?");
    if (!userTurnSaved) await saveTurn(userId, "user", message);
    if (finalReply) await saveTurn(userId, "assistant", finalReply);
    return { reply: finalReply, capture, offerAngles };
  }
}
