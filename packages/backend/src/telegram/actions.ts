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
import type { ChatTool } from "./chat-tools.js";

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
      `${platform === "x" ? "X" : "LinkedIn"} ingestion isn't configured on this instance yet.\n\n` +
      "To try the full flow now: send me a handful of your actual takes (just type them), then /diagnose — " +
      "or /demo to load a sample profile and watch the whole thing run.";
    await channel.say(msg);
    return msg;
  }
  await startConnect(user.id, platform, handle);
  // Handle received — stop treating bare words as handle answers.
  const st = await getState(user.id);
  if (st.awaitingConnect) await setState(user.id, { ...st, awaitingConnect: false });
  const msg =
    `On it — pulling your ${platform === "x" ? "X" : "LinkedIn"} history now. This takes a few minutes; ` +
    "I'll come back with a full read once I've actually gone through it. A shallow diagnosis is worse than none.";
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
    const msg = "Drafting is a paid feature — /upgrade to have me write for you.";
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
  const otherPlatform = platform === "x" ? "li" : "x";
  const otherLabel = platform === "x" ? "♻️ LinkedIn version" : "♻️ X version";
  const kb = row ? new InlineKeyboard().text(otherLabel, `rpz:d:${row.id}:${otherPlatform}`) : undefined;
  await channel.say(`✍️ Draft:\n\n${res.draft}`, kb);
  return `✍️ Draft (${platform}):\n\n${res.draft}`;
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
  const text = `♻️\n\n${result.output}${result.notes ? `\n\n(${result.notes})` : ""}`;
  await channel.say(text, kb);
  return text;
}

/** The /check flow: consistency verdict on a pasted draft, entitlement-gated. */
export async function runCheck(user: User, draft: string, channel: Channel): Promise<string> {
  const ent = await entitlementsFor(user.id);
  if (!ent.consistencyChecks) {
    const msg = "Consistency checks are a paid feature — /upgrade to turn them on.";
    await channel.say(msg);
    return msg;
  }
  const result = await checkConsistency(user.id, draft);
  const body = result.clear
    ? "✅ Clear — no tension with your positions or throughline."
    : result.flags
        .map((f) => `⚠️ ${f.positionId === "throughline" ? "Off your throughline" : "Contradicts"}: "${f.statement}"\n→ ${f.explanation}`)
        .join("\n\n");
  await channel.say(body);
  return body;
}

/** The /positions body: active beliefs with confidence, or the empty-state nudge. */
export async function positionsText(userId: string): Promise<string> {
  const positions = await activePositions(userId, { includeStale: true });
  if (positions.length === 0) return "No positions yet — send me your takes or /connect an account.";
  const lines = positions.map((p) => {
    const pct = Math.round(p.confidence * 100);
    const n = p.source_memory_ids.length;
    return `• ${p.statement}\n   ${pct}% held · said ${n} time${n === 1 ? "" : "s"}`;
  });
  return "What you've staked out (confidence decays if you stop saying it):\n\n" + lines.join("\n");
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
    new: "Start with /connect so I can read your work.",
    connected: "I'm reading your history — /diagnosis will be ready shortly.",
    diagnosed: "See /diagnosis, then tell me your goal to get a plan.",
    goals_set: "Goal locked — say the word and I'll finish your /plan.",
    plan_active: "Plan's live. Keep capturing; I'll bring you moments and angles.",
  };
  return (
    `Stage: ${stage} · plan: ${ent.plan}\n` +
    `${c?.memories ?? 0} memories · ${c?.positions ?? 0} positions\n` +
    (plan ? `Throughline: ${plan.throughline}\n` : "") +
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
        const msg = "Couldn't work out what to reshape there — paste the post and tell me the target.";
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
      const msg = plan ? formatPlan(plan) : "No active plan yet. Once you're diagnosed, I'll build one with you.";
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
        const msg = "Nothing to read yet — hand me your @handle (or a few of your takes) first.";
        await channel.say(msg);
        return msg;
      }
      if (stage === "active" || stage === "plan_active") {
        // Post-onboarding: refresh in place, never re-open the paced session arc.
        const refreshed = await runDiagnosis(user.id, { deliver: false }).catch(() => null);
        if (!refreshed) {
          const msg = "Couldn't refresh the read just now — try again in a bit. Your existing /diagnosis still stands.";
          await channel.say(msg);
          return msg;
        }
        for (const chunk of formatDiagnosis(refreshed)) await channel.say(chunk);
        return "(delivered a refreshed diagnosis)";
      }
      await getBoss().send(QUEUES.diagnose, { userId: user.id, attempt: 0 });
      const msg = "Reading through everything now. Give me a minute and I'll open with what stands out.";
      await channel.say(msg);
      return msg;
    }

    case "connect_account":
      return connectAccount(user, tool.platform, tool.handle, channel);

    case "forget": {
      const matches = await hybridSearch(user.id, tool.query, 3);
      if (matches.length === 0) {
        const msg = "Nothing in memory matches that.";
        await channel.say(msg);
        return msg;
      }
      const kb = new InlineKeyboard();
      for (const m of matches) kb.text(`🗑 ${m.content.slice(0, 40)}…`, `cf:${m.id}`).row();
      kb.text("Cancel", "cf:cancel");
      await channel.say("Delete which? This is permanent.", kb);
      return "(offered forget choices — waiting on their pick)";
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
    if (momentId) keyboard = new InlineKeyboard().text("✍️ Turn this into angles", `mkang:${momentId}`);
  }
  if (result.reply) await channel.say(result.reply, keyboard);

  if (result.tool) {
    try {
      const trace = await executeChatTool(user, result.tool, channel);
      // Keep history honest: the brain said "on it", this is what "it" was.
      await saveTurn(user.id, "assistant", trace.slice(0, 1500)).catch(() => {});
    } catch (err) {
      console.error(`chat tool ${result.tool.name} failed`, err);
      await channel.say("That one didn't go through on my end. Give it another shot in a moment.");
    }
  }
}
