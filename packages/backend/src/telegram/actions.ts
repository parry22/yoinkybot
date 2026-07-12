import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import type { User } from "../lib/auth.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { generateDraft } from "../drafting/draft.js";
import { repurposeContent, parseRepurposeCommand } from "../drafting/repurpose.js";
import { searchAndSynthesize, hybridSearch } from "../memory/search.js";
import { checkConsistency } from "../consistency/check.js";
import { getPlan, formatPlan } from "../strategist/plan.js";
import { activePositions } from "../memory/positions.js";
import { getStage, getState, setState } from "../strategist/state.js";
import { startConnect } from "../strategist/connect.js";
import { runDiagnosis, formatDiagnosis } from "../strategist/diagnosis.js";
import { getBoss, QUEUES } from "../jobs/boss.js";
import { createCapture } from "../capture/service.js";
import { createIdeaMoment } from "../jobs/offer-angles.js";
import { saveTurn } from "./conversation.js";
import { recordCorrection, encodeCorrection } from "../memory/corrections.js";
import { track } from "../analytics/posthog.js";
import { schedulePost, listScheduled } from "../scheduling/service.js";
import { publishConfigured, resolveWriteAuth } from "../social/publish.js";
import type { ChatTool } from "./chat-tools.js";

/** ISO instant → compact, unambiguous UTC label for confirmations and lists. */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * List the user's pending scheduled posts with a per-post cancel button. Shared
 * by the /scheduled command and any chat path that wants to show the queue.
 */
export async function runShowScheduled(user: User, channel: Channel): Promise<string> {
  const posts = await listScheduled(user.id);
  if (posts.length === 0) {
    const msg = "nothing scheduled right now. tell me what to post and when, e.g. \"post this to linkedin tomorrow 9am: …\".";
    await channel.say(msg);
    return msg;
  }
  const kb = new InlineKeyboard();
  const lines = posts.map((p, i) => {
    const label = p.platform === "x" ? "X" : "LinkedIn";
    const preview = p.content.length > 80 ? `${p.content.slice(0, 80)}…` : p.content;
    kb.text(`🗑 cancel ${label} · ${whenLabel(p.scheduled_for)}`, `schedq:cancel:${p.id}`).row();
    return `${i + 1}. ${label} · ${whenLabel(p.scheduled_for)}\n   ${preview}`;
  });
  const msg = `📅 scheduled (${posts.length}):\n\n${lines.join("\n\n")}`;
  await channel.say(msg, kb);
  return msg;
}

/**
 * Queue a post for later. Validates the resolved time, saves it, and confirms
 * with the absolute time echoed back (so a mis-parsed "tomorrow" is obvious).
 * Warns — but still schedules — when the account isn't connected for posting,
 * since the write-OAuth may be completed before the post is due.
 */
export async function runSchedulePost(
  user: User,
  platform: "x" | "linkedin",
  content: string,
  when: string,
  channel: Channel,
): Promise<string> {
  const res = await schedulePost(user.id, { platform, content, scheduledFor: new Date(when) });
  if (!res.ok) {
    const msg = `couldn't schedule that — ${res.reason}. give me a clear time like "tomorrow 9am" or "friday 6pm".`;
    await channel.say(msg);
    return msg;
  }
  const label = platform === "x" ? "X" : "LinkedIn";
  const canPost = publishConfigured(platform) && (await resolveWriteAuth(user.id, platform));
  const warn = canPost
    ? ""
    : `\n\nheads up: your ${label} isn't connected for posting yet, so connect it before then or this won't actually go out.`;
  const msg = `📅 scheduled for ${label} at ${whenLabel(new Date(when).toISOString())}.${warn}\n\n/scheduled to see or cancel.`;
  await channel.say(msg);
  return msg;
}

/**
 * Where a turn's output goes. Live chat wraps grammY's ctx; async paths (the
 * voice-note reply after transcription) wrap sendTelegram. Keeping the executor
 * channel-based means every capability works identically from a typed message,
 * a voice note, or a button — one code path per feature, many entry points.
 */
export interface Channel {
  say(text: string, keyboard?: InlineKeyboard): Promise<void>;
  typing?(): Promise<void>;
}

/**
 * Kick off a real scrape+diagnose for a handle. Shared by the /connect command,
 * the deterministic natural-language intent path, and the connect_account chat
 * tool. Gates on the ingestion credentials THIS platform needs, so a
 * misconfigured instance degrades to "send me your takes" instead of silently
 * queueing a job that will fail.
 */
export async function connectAccount(
  user: User,
  platform: "x" | "linkedin",
  handle: string,
  channel: Channel,
): Promise<string> {
  const canIngest =
    platform === "x" ? !!(config.TWITTERAPI_IO_KEY || config.APIFY_TOKEN) : !!config.APIFY_TOKEN;
  if (!canIngest) {
    const msg =
      `${platform === "x" ? "X" : "LinkedIn"} ingestion isn't wired up on this instance yet.\n\n` +
      "to try the full thing now, just type me a handful of your actual takes and i'll read those instead.";
    await channel.say(msg);
    return msg;
  }
  await startConnect(user.id, platform, handle);
  // Handle received — stop treating bare words as handle answers.
  const st = await getState(user.id);
  if (st.awaitingConnect) await setState(user.id, { ...st, awaitingConnect: false });
  const msg =
    `on it, pulling your ${platform === "x" ? "X" : "LinkedIn"} history now. takes a few minutes. ` +
    "i'll come back once i've actually read the whole thing, a shallow read is worse than none.";
  await channel.say(msg);
  return msg;
}

/** Generate, persist, and deliver a draft with the one-tap cross-platform repurpose button. */
export async function runDraft(
  user: User,
  topic: string,
  platform: "x" | "linkedin",
  channel: Channel,
): Promise<string> {
  const ent = await entitlementsFor(user.id);
  if (!ent.drafting) {
    const msg = "drafting's a paid thing, hit /upgrade and i'll write for you.";
    await channel.say(msg);
    return msg;
  }
  const res = await generateDraft(user.id, topic, platform);
  if (!res.ok) {
    await channel.say(res.note);
    return res.note;
  }
  // Persist so the repurpose button can find the text later (and so the
  // performance report's drafts-written count reflects reality).
  const row = await queryOne<{ id: string }>(
    `INSERT INTO drafts (user_id, content, platform, source_memory_ids, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [user.id, res.draft, platform, res.sources.map((s) => s.id), res.note ?? ""],
  );
  track(user.id, "draft_generated", { platform, sources: res.sources.length });
  const otherPlatform = platform === "x" ? "li" : "x";
  const otherLabel = platform === "x" ? "♻️ LinkedIn version" : "♻️ X version";
  const kb = row ? new InlineKeyboard().text(otherLabel, `rpz:d:${row.id}:${otherPlatform}`) : undefined;
  // The draft itself is content for their feed, so it keeps its own capitalization;
  // only the little label around it is Yoinky talking.
  await channel.say(`✍️ here you go:\n\n${res.draft}`, kb);
  return `✍️ draft (${platform}):\n\n${res.draft}`;
}

/** One repurposed variant at a time: the output, any honest caveats, and a used/skip loop. */
export async function deliverRepurposed(
  channel: Channel,
  result: { ok: boolean; id?: string; output: string; notes: string },
): Promise<string> {
  if (!result.ok) {
    await channel.say(result.notes);
    return result.notes;
  }
  const kb = result.id
    ? new InlineKeyboard().text("✅ posted it", `rpu:${result.id}:used`).text("⏭ not this one", `rpu:${result.id}:skip`)
    : undefined;
  // The reshaped post is content — leave it exactly as written, notes stay lowercase.
  const text = `♻️ here's the reshaped version:\n\n${result.output}${result.notes ? `\n\n(${result.notes})` : ""}`;
  await channel.say(text, kb);
  return text;
}

/** The /check flow: consistency verdict on a pasted draft, entitlement-gated. */
export async function runCheck(user: User, draft: string, channel: Channel): Promise<string> {
  const ent = await entitlementsFor(user.id);
  if (!ent.consistencyChecks) {
    const msg = "consistency checks are a paid thing, /upgrade to turn them on.";
    await channel.say(msg);
    return msg;
  }
  const result = await checkConsistency(user.id, draft);
  const body = result.clear
    ? result.notes?.length
      ? `✅ clear to post. one read worth knowing: ${result.notes.join(" ")}`
      : "✅ clear, no tension with your positions or throughline."
    : result.flags
        .map((f) => `⚠️ ${f.positionId === "throughline" ? "off your throughline" : "contradicts"}: "${f.statement}"\n→ ${f.explanation}`)
        .join("\n\n");
  await channel.say(body);
  return body;
}

/** The /positions body: active beliefs with confidence, or the empty-state nudge. */
export async function positionsText(userId: string): Promise<string> {
  const positions = await activePositions(userId, { includeStale: true });
  if (positions.length === 0) return "no positions yet, send me your takes or connect an account.";
  const lines = positions.map((p) => {
    const pct = Math.round(p.confidence * 100);
    const n = p.source_memory_ids.length;
    return `• ${p.statement}\n   ${pct}% held · said ${n} time${n === 1 ? "" : "s"}`;
  });
  return "what you've staked out (confidence decays if you stop saying it):\n\n" + lines.join("\n");
}

/** The /status body: stage, counts, plan, and the next move. */
export async function statusText(user: User): Promise<string> {
  const [stage, counts, plan, ent] = await Promise.all([
    getStage(user.id),
    query<{ memories: string; positions: string }>(
      `SELECT (SELECT count(*) FROM memories WHERE user_id=$1 AND status='active')::text memories,
              (SELECT count(*) FROM positions WHERE user_id=$1 AND status='active')::text positions`,
      [user.id],
    ),
    getPlan(user.id),
    entitlementsFor(user.id),
  ]);
  const c = counts[0];
  const next: Record<string, string> = {
    new: "start by connecting an account so i can read your work. just drop your @handle.",
    connected: "i'm reading your history right now, the read'll be ready shortly.",
    diagnosed: "you've got a read, tell me your goal and i'll build a plan.",
    goals_set: "goal's locked, say the word and i'll finish your plan.",
    plan_active: "plan's live. keep capturing and i'll bring you moments and angles.",
  };
  return (
    `stage: ${stage} · plan: ${ent.plan}\n` +
    `${c?.memories ?? 0} memories · ${c?.positions ?? 0} positions\n` +
    (plan ? `throughline: ${plan.throughline}\n` : "") +
    `\n${next[stage] ?? ""}`
  );
}

/**
 * Execute one chat tool through the same code path its slash command uses.
 * Returns a short trace of what was delivered so the caller can persist it as
 * an assistant turn — next turn, the brain remembers what it actually did.
 */
export async function executeChatTool(user: User, tool: ChatTool, channel: Channel): Promise<string> {
  await channel.typing?.();

  switch (tool.name) {
    case "draft_post":
      return runDraft(user, tool.topic, tool.platform, channel);

    case "repurpose": {
      const parsed = parseRepurposeCommand(`${tool.form} ${tool.text}`);
      if (!parsed) {
        const msg = "couldn't work out what to reshape there. paste the post and tell me where it's going.";
        await channel.say(msg);
        return msg;
      }
      const result = await repurposeContent(user.id, {
        mode: parsed.mode,
        target: parsed.target,
        direction: parsed.direction,
        sourceType: parsed.mode === "synthesis" ? "memory_cluster" : "pasted_content",
        sourceText: parsed.mode === "synthesis" ? undefined : parsed.text,
        theme: parsed.mode === "synthesis" ? parsed.text : undefined,
      });
      return deliverRepurposed(channel, result);
    }

    case "search_memory": {
      const { answer } = await searchAndSynthesize(user.id, tool.question);
      await channel.say(answer);
      return answer;
    }

    case "check_draft":
      return runCheck(user, tool.text, channel);

    case "show_plan": {
      const plan = await getPlan(user.id);
      const msg = plan ? formatPlan(plan) : "no plan yet. once i've read you, i'll build one with you.";
      await channel.say(msg);
      return msg;
    }

    case "show_positions": {
      const msg = await positionsText(user.id);
      await channel.say(msg);
      return msg;
    }

    case "show_status": {
      const msg = await statusText(user);
      await channel.say(msg);
      return msg;
    }

    case "refresh_diagnosis": {
      const stage = await getStage(user.id);
      if (stage === "new") {
        const msg = "nothing to read yet, hand me your @handle (or a few of your takes) first.";
        await channel.say(msg);
        return msg;
      }
      if (stage === "active" || stage === "plan_active") {
        // Post-onboarding: refresh in place, never re-open the paced session arc.
        const refreshed = await runDiagnosis(user.id, { deliver: false }).catch(() => null);
        if (!refreshed) {
          const msg = "couldn't refresh the read just now, try again in a bit. your existing read still stands.";
          await channel.say(msg);
          return msg;
        }
        for (const chunk of formatDiagnosis(refreshed)) await channel.say(chunk);
        return "(delivered a refreshed diagnosis)";
      }
      await getBoss().send(QUEUES.diagnose, { userId: user.id, attempt: 0 });
      const msg = "reading through everything now. give me a minute and i'll open with what stands out.";
      await channel.say(msg);
      return msg;
    }

    case "connect_account":
      return connectAccount(user, tool.platform, tool.handle, channel);

    case "forget": {
      const matches = await hybridSearch(user.id, tool.query, 3);
      if (matches.length === 0) {
        const msg = "nothing in memory matches that.";
        await channel.say(msg);
        return msg;
      }
      const kb = new InlineKeyboard();
      for (const m of matches) kb.text(`🗑 ${m.content.slice(0, 40)}…`, `cf:${m.id}`).row();
      kb.text("Cancel", "cf:cancel");
      await channel.say("which one? this is permanent.", kb);
      return "(offered forget choices — waiting on their pick)";
    }

    case "correct_classification": {
      const matches = await hybridSearch(user.id, tool.query, 5);
      // Correction is capture-level (memory/classification.ts) — a search can
      // return several memory units split from the same post, so collapse to
      // one candidate per capture before presenting choices.
      const byCapture = new Map<string, (typeof matches)[number]>();
      for (const m of matches) if (m.capture_id && !byCapture.has(m.capture_id)) byCapture.set(m.capture_id, m);
      const candidates = [...byCapture.entries()];
      const code = encodeCorrection(tool.field, tool.correctedValue);

      if (candidates.length === 0) {
        const msg = "can't find that post in memory.";
        await channel.say(msg);
        return msg;
      }
      // A single clear match, or a value that can't be compactly encoded into a
      // button (only possible for rhetorical_mode) — apply directly to the best match.
      if (candidates.length === 1 || !code) {
        const [captureId] = candidates[0]!;
        const result = await recordCorrection(user.id, captureId, tool.field, tool.correctedValue);
        const msg = result.acknowledgment ? `got it, corrected.\n\n${result.acknowledgment}` : "got it, corrected.";
        await channel.say(msg);
        return msg;
      }
      const kb = new InlineKeyboard();
      for (const [captureId, m] of candidates) kb.text(`✏️ ${m.content.slice(0, 40)}…`, `corr:${captureId}:${code}`).row();
      kb.text("Cancel", "cf:cancel");
      await channel.say("which one? that'll flip its reading.", kb);
      return "(offered correction choices — waiting on their pick)";
    }

    case "clear_everything": {
      // Never wipes directly — same clr:confirm/clr:cancel callback data the
      // old /clear command used, handled in telegram/bot.ts's callback_query
      // listener (deletes the visible chat, then resetUserData, then restarts
      // onboarding). This only surfaces the confirmation.
      const kb = new InlineKeyboard().text("Yes, wipe everything", "clr:confirm").row().text("Cancel", "clr:cancel");
      const msg =
        "this wipes everything: your captured history, memories, positions, the read, goals, plan, " +
        "and deletes every message in this chat, mine and yours. you'll start over from scratch. " +
        "can't be undone.\n\nsure?";
      await channel.say(msg, kb);
      return "(offered the wipe-everything confirmation — waiting on their tap)";
    }
  }
}

export interface TurnOutput {
  reply: string;
  capture: boolean;
  offerAngles: boolean;
  tool?: ChatTool;
}

/**
 * The mid-turn tool executor for the conversational loop (converse.v3): sends
 * the brain's short beat ("on it, checking that first"), runs the tool through
 * the same code path its slash command uses, and persists both as assistant
 * turns — a 3-tool turn shows up as its fragments in history, not one opaque
 * blob. Returns the trace the loop feeds back to the model.
 */
export function chatToolExecutor(user: User, channel: Channel) {
  return async (tool: ChatTool, replyBeat: string): Promise<string> => {
    if (replyBeat) {
      await channel.say(replyBeat);
      await saveTurn(user.id, "assistant", replyBeat).catch(() => {});
    }
    const trace = await executeChatTool(user, tool, channel);
    // Keep history honest: the brain said "on it", this is what "it" was.
    await saveTurn(user.id, "assistant", trace.slice(0, 1500)).catch(() => {});
    return trace;
  };
}

/**
 * Shared tail for every conversational entry point (typed text, voice-note
 * transcript, the paced session): file a genuine thought, send the reply,
 * offer angles, then execute the tool the brain called — and persist what the
 * tool actually delivered so the next turn's history reflects reality.
 */
export async function deliverTurnOutput(
  user: User,
  text: string,
  result: TurnOutput,
  channel: Channel,
  opts: { alreadyCaptured?: boolean } = {},
): Promise<void> {
  if (result.capture && !opts.alreadyCaptured) {
    await createCapture({ userId: user.id, source: "telegram_text", rawText: text });
  }
  let keyboard: InlineKeyboard | undefined;
  if (result.offerAngles && !result.tool) {
    const momentId = await createIdeaMoment(user.id, text, text);
    if (momentId) keyboard = new InlineKeyboard().text("✍️ turn this into angles", `mkang:${momentId}`);
  }
  if (result.reply) await channel.say(result.reply, keyboard);

  if (result.tool) {
    try {
      const trace = await executeChatTool(user, result.tool, channel);
      // Keep history honest: the brain said "on it", this is what "it" was.
      await saveTurn(user.id, "assistant", trace.slice(0, 1500)).catch(() => {});
    } catch (err) {
      console.error(`chat tool ${result.tool.name} failed`, err);
      await channel.say("that one didn't go through on my end. give it another shot in a sec.");
    }
  }
}
