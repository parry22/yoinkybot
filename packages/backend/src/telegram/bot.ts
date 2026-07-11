import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../config.js";
import { queryOne } from "../db/pool.js";
import {
  consumeTelegramLinkToken,
  findOrCreateUserByTelegram,
  type User,
} from "../lib/auth.js";
import { createCapture } from "../capture/service.js";
import { forgetMemory } from "../memory/forget.js";
import { draftFromAngle } from "../drafting/angle-draft.js";
import { converseWithUser, saveTurn } from "./conversation.js";
import { maybeOfferAngles, createIdeaMoment } from "../jobs/offer-angles.js";
import { otherUnconnectedPlatform } from "../strategist/connect.js";
import { diagnosisById } from "../strategist/diagnosis.js";
import { getStage, getState, setState, setStage, isOnboardingPhase, isProfilingPhase } from "../strategist/state.js";
import { runSessionTurn } from "../strategist/session-machine.js";
import { FALLBACK_QUESTION } from "../prompts/strategist-session.v2.js";
import {
  PROFILE_FIELDS,
  getProfile,
  upsertProfileField,
  TONE_TAXONOMY,
  ALL_TONE_KEYS,
  type ProfileField,
} from "../strategist/profile.js";
import { buildVoiceProfile } from "../voice/profile.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { createCheckout, foundingSeatsLeft } from "../billing/dodo.js";
import { resetUserData } from "../strategist/state.js";
import { recordReplyOutcome } from "../engagement/service.js";
import { parseRepurposeCommand, repurposeContent, recordRepurposeUse } from "../drafting/repurpose.js";
import { parsePeersCommand, addPeer, removePeer, listPeers } from "../benchmark/peers.js";
import { parseSettingsCommand, applySettings, SETTINGS_USAGE } from "./settings.js";
import { trackOutgoingMessages, recordMessage, deleteAllTrackedMessages } from "./message-log.js";
import { casualize } from "../prompts/style.js";
import {
  type Channel,
  connectAccount,
  runDraft,
  deliverRepurposed,
  deliverTurnOutput,
} from "./actions.js";
import { runSerializedTurn } from "./turns.js";

let bot: Bot | undefined;

export function getBot(): Bot | undefined {
  return bot;
}

/** Channel over a live grammY context — replies land in the chat that spoke. */
function ctxChannel(ctx: Context): Channel {
  return {
    say: async (text, keyboard) => {
      await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
    },
    typing: async () => {
      await ctx.replyWithChatAction("typing").catch(() => {});
    },
  };
}

/**
 * Channel that DMs a user outside a live update (voice-note replies after
 * transcription, job-driven follow-ups). Falls back to a silent no-op when the
 * bot isn't running or the user has no Telegram link.
 */
export function dmChannel(userId: string): Channel {
  return {
    say: async (text, keyboard) => {
      await sendTelegram(userId, text, undefined, keyboard);
    },
    typing: async () => {
      if (!bot) return;
      const user = await queryOne<{ telegram_id: string | null }>(
        `SELECT telegram_id FROM users WHERE id = $1`,
        [userId],
      );
      if (user?.telegram_id) await bot.api.sendChatAction(Number(user.telegram_id), "typing").catch(() => {});
    },
  };
}

/**
 * Telegram's typing indicator lives ~5 seconds; a real turn (retrieval + LLM,
 * worst case with retries) can run far longer. Dead air mid-conversation is the
 * fastest way to feel like a broken bot, so keep the indicator alive until the
 * work resolves.
 */
export async function withTyping<T>(channel: Channel, fn: () => Promise<T>): Promise<T> {
  void channel.typing?.();
  const timer = setInterval(() => void channel.typing?.(), 4500);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

export function createBot(): Bot | undefined {
  if (!config.TELEGRAM_BOT_TOKEN) {
    console.warn("TELEGRAM_BOT_TOKEN not set — Telegram capture disabled");
    return undefined;
  }
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Track every outgoing message's (chat_id, message_id) so wiping everything can
  // delete the visible chat, not just derived data. Registered on bot.api.config, so
  // grammY re-applies it to every per-update ctx.api AND direct bot.api calls
  // from job/worker code (sendTelegram, sendTelegramSequence) — see message-log.ts.
  bot.api.config.use(trackOutgoingMessages);

  // Track every genuine incoming message the same way (never for callback_query
  // or edited-message updates — only real new messages count as "chat history").
  bot.use(async (ctx, next) => {
    const msg = ctx.update.message;
    if (msg && ctx.chat?.type === "private") {
      const user = await findOrCreateUserByTelegram(msg.from.id);
      await recordMessage(user.id, msg.chat.id, msg.message_id);
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim();
    if (payload) {
      const linked = await consumeTelegramLinkToken(payload, ctx.from!.id);
      if (linked) {
        await ctx.reply("linked to your yoink account. send me a thought, voice or text, and it's captured.");
        return;
      }
    }
    const user = await findOrCreateUserByTelegram(ctx.from!.id);
    const stage = await getStage(user.id);
    // Only a genuinely finished user is "set up" — everyone else (new, or partway
    // through onboarding) should be in the intake, not told they're done.
    if (stage === "active" || stage === "plan_active") {
      await ctx.reply("you're all set up. send me a thought whenever, or /plan to see where we're headed.");
      return;
    }
    const st = await getState(user.id);
    // Mid-intake with real progress → resume where they left off, don't wipe it.
    if (isProfilingPhase(st) && (st.profile?.captured?.length ?? 0) > 0) {
      const next = nextIntakeField(st.profile?.captured);
      await ctx.reply(
        next
          ? `picking up where we left off. ${FALLBACK_QUESTION[next as ProfileField]}`
          : "we're almost there. drop your X handle (like @yourname) or your LinkedIn profile URL and I'll read your history.",
      );
      return;
    }
    // Fresh start: profile-first, so the diagnosis lands as a stated-vs-actual gap.
    await setStage(user.id, "profiling");
    await setState(user.id, { phase: "profiling", profile: {} });
    await ctx.reply(PROFILE_OPENER);
  });

  // Connect a public account so the strategist can ingest your history + diagnose.
  bot.command("connect", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const arg = ctx.match?.trim();
    if (!arg) {
      const st = await getState(user.id);
      await setState(user.id, { ...st, awaitingConnect: true });
      await ctx.reply(
        "connect your public presence so i can read your work. " +
          "just send your @handle, or:\n" +
          "/connect x <your @handle>\n/connect linkedin <your profile url>",
      );
      return;
    }
    const [platformRaw, ...rest] = arg.split(/\s+/);
    const platform = platformRaw?.toLowerCase();
    const handle = rest.join(" ").trim();
    if ((platform !== "x" && platform !== "linkedin") || !handle) {
      await ctx.reply("usage: /connect x <@handle>  or  /connect linkedin <profile url>");
      return;
    }
    await beginConnect(ctx, user, platform, handle);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "everything happens right here in the chat. mostly, just talk to me.\n\n" +
        "getting set up:\n" +
        "send /start and i'll walk you through a few questions, then read your real history.\n\n" +
        "the work (all of this works in plain words too):\n" +
        "/draft your idea  — i turn a thought into a post in your voice\n" +
        "/repurpose  — reshape a finished post for another platform, or pull scattered takes into one piece\n" +
        "/peers  — watch a few peers, compare territory (never raw numbers)\n\n" +
        "housekeeping:\n" +
        "/settings  — quiet hours, timezone, how often i reach out\n" +
        "/upgrade  — unlock the paid work\n\n" +
        "or just say what you want: \"draft me a post about X\", \"does this contradict what i've said\", " +
        "\"what have i said about pricing\", \"where am i at\", \"what's my plan\", \"what do i believe\", " +
        "\"wipe everything and start over\". bring me a thought and i'll find the story in it.",
    );
  });

  bot.command("draft", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const arg = ctx.match?.trim();
    if (!arg) return void (await ctx.reply("tell me what to write: /draft <topic or angle>  (or /draft linkedin <topic>)"));
    // Optional leading platform token: "/draft linkedin <topic>" / "/draft x <topic>".
    // Defaults to X. Everything after the token is the actual brief.
    const platMatch = arg.match(/^(x|twitter|linkedin|li)\s+([\s\S]+)$/i);
    const platform: "x" | "linkedin" = platMatch && /^(linkedin|li)$/i.test(platMatch[1]!) ? "linkedin" : "x";
    const topic = platMatch ? platMatch[2]!.trim() : arg;
    await withTyping(ctxChannel(ctx), () => runDraft(user, topic, platform, ctxChannel(ctx)));
  });

  // Quiet hours, timezone, proactive frequency — how I behave around your life.
  bot.command("settings", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const cmd = parseSettingsCommand(ctx.match ?? "");
    if (!cmd) return void (await ctx.reply(`didn't catch that.\n\n${SETTINGS_USAGE}`));
    await ctx.reply(await applySettings(user.id, cmd));
  });

  // Peer watchlist: explicit adds only, capped small, territory comparison only.
  bot.command("peers", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const cmd = parsePeersCommand(ctx.match ?? "");
    if (!cmd) {
      await ctx.reply("usage:\n/peers  — see the watchlist\n/peers add @handle why them\n/peers remove @handle");
      return;
    }
    if (cmd.kind === "list") return void (await ctx.reply(await listPeers(user.id)));
    if (cmd.kind === "add") return void (await ctx.reply(await addPeer(user.id, cmd.platform, cmd.handle, cmd.note)));
    await ctx.reply(await removePeer(user.id, cmd.handle));
  });

  // Transform finished material: cross-platform, compress/expand, or synthesis.
  bot.command("repurpose", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const parsed = parseRepurposeCommand(ctx.match ?? "");
    if (!parsed) {
      await ctx.reply(
        "reshape something that already exists:\n" +
          "/repurpose linkedin <paste a post>  (X post, made native to LinkedIn)\n" +
          "/repurpose x <paste a post>  (the reverse)\n" +
          "/repurpose compress <paste a thread>  (thread down to one post)\n" +
          "/repurpose expand <paste a post>  (one post up to a thread, only if it earns it)\n" +
          "/repurpose synthesis <the idea>  (pull your scattered takes on it into one piece)",
      );
      return;
    }
    await withTyping(ctxChannel(ctx), async () => {
      const result = await repurposeContent(user.id, {
        mode: parsed.mode,
        target: parsed.target,
        direction: parsed.direction,
        sourceType: parsed.mode === "synthesis" ? "memory_cluster" : "pasted_content",
        sourceText: parsed.mode === "synthesis" ? undefined : parsed.text,
        theme: parsed.mode === "synthesis" ? parsed.text : undefined,
      });
      await deliverRepurposed(ctxChannel(ctx), result);
    });
  });

  bot.command("upgrade", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const ent = await entitlementsFor(user.id);
    if (ent.plan !== "free") return void (await ctx.reply(`you're on ${ent.plan}, you've got everything. 🙌`));
    const seats = await foundingSeatsLeft().catch(() => 0);
    const kb = new InlineKeyboard()
      .text(seats > 0 ? `Founding (${seats} left, price locked)` : "Founding (full)", "bill:founding")
      .row()
      .text("Paid", "bill:paid");
    await ctx.reply("unlock consistency checks, drafting, voice profile, and macro-moment matching:", { reply_markup: kb });
  });

  // Voice notes / audio → capture with the Telegram file URL; transcription is async.
  bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const fileId =
      ctx.message?.voice?.file_id ?? ctx.message?.audio?.file_id ?? ctx.message?.video_note?.file_id;
    if (!fileId) return;
    const file = await ctx.api.getFile(fileId);
    const audioUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    await createCapture({
      userId: user.id,
      source: "telegram_voice",
      audioUrl,
      metadata: { telegram_file_id: fileId, duration: ctx.message?.voice?.duration ?? null },
    });
    // The real reply lands after transcription (jobs/transcribe.ts runs the
    // transcript through the conversation brain) — this is just the "I heard you".
    await ctx.reply("🎙 got it, listening now, back in a moment.");
  });

  bot.on("message:text", async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const text = ctx.message.text.trim();
    if (!text) return;
    // A slash message reaching here is a command we don't have — every real
    // command was consumed by its bot.command() handler above. Answer it
    // instead of going silent.
    if (text.startsWith("/")) {
      await ctx.reply("don't know that one. /help lists everything, or just say what you want in plain words.");
      return;
    }
    // Immediate "I'm on it" the instant we process the update — matters most on a
    // cold start, so a slow first turn reads as thinking, not offline. withTyping
    // then keeps it alive for the rest of the turn.
    void ctx.replyWithChatAction("typing").catch(() => {});
    // Serialize per user: one turn at a time, and messages typed while a turn
    // is running merge into the next turn (people send one thought as several
    // fragments — answer the whole thought once, like a person would).
    await runSerializedTurn(user.id, text, ctx, (merged, c) => handleTextTurn(user, merged, c));
  });

  // Media we can't see yet. A caption is still the user talking to us — route
  // it through the normal turn (with an honest note about the attachment).
  // Captionless media gets a straight answer instead of dead silence.
  bot.on(["message:photo", "message:video", "message:document", "message:animation"], async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const caption = ctx.message.caption?.trim();
    if (caption) {
      const framed = `[they attached media you can't see; its caption:] ${caption}`;
      await runSerializedTurn(user.id, framed, ctx, (merged, c) => handleTextTurn(user, merged, c));
      return;
    }
    await ctx.reply(
      "can't see images or files yet, text and voice are my inputs. tell me the thought behind it (or paste the text) and i've got it.",
    );
  });

  // Last-resort catch-all so no message type is ever met with silence
  // (stickers, contacts, polls, locations…). Registered after every real
  // handler; grammY only lands here when nothing above consumed the update.
  bot.on("message", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await ctx.reply("that one's outside what i can read, i work with text and voice notes.");
  });

  // Inline reactions on surfacings + forget confirmations.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const user = await requireUser(ctx);
    if (!user) return void (await ctx.answerCallbackQuery());

    if (data.startsWith("cf:")) {
      const id = data.slice(3);
      if (id === "cancel") {
        await ctx.editMessageText("cancelled.");
      } else {
        const ok = await forgetMemory(user.id, id);
        await ctx.editMessageText(ok ? "gone. permanently." : "already gone.");
      }
      return void (await ctx.answerCallbackQuery());
    }

    if (data.startsWith("clr:")) {
      if (data === "clr:confirm") {
        // Ack immediately — deleting a long chat history can take a few
        // seconds and answerCallbackQuery has its own short timeout.
        await ctx.answerCallbackQuery({ text: "wiping everything…" });
        // Delete the visible chat FIRST, while telegram_messages still has the
        // ids — resetUserData wipes that table along with everything else.
        await deleteAllTrackedMessages(ctx.api, user.id).catch((err) =>
          console.error("clear: message deletion sweep failed", err),
        );
        await resetUserData(user.id);
        // Restart the profile-first onboarding from scratch (same as /start), so
        // wiping everything lands them back at question one rather than a dead
        // "connect an account" prompt. The fresh message gets tracked like everything else.
        await setStage(user.id, "profiling");
        await setState(user.id, { phase: "profiling", profile: {} });
        await ctx.reply(`done. clean slate.\n\n${PROFILE_OPENER}`);
        return;
      }
      await ctx.editMessageText("cancelled. nothing was deleted.");
      return void (await ctx.answerCallbackQuery());
    }

    const m = /^rx:([0-9a-f-]{36}):(fire|later|forget)$/.exec(data);
    if (m) {
      const [, surfacingId, reaction] = m as unknown as [string, string, "fire" | "later" | "forget"];
      const surfacing = await queryOne<{ id: string; memory_ids: string[] }>(
        `UPDATE surfacings SET user_reaction = $3, reaction_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING id, memory_ids`,
        [surfacingId, user.id, reaction],
      );
      if (surfacing && reaction === "forget") {
        for (const memId of surfacing.memory_ids) await forgetMemory(user.id, memId);
      }
      await ctx.answerCallbackQuery({
        text: reaction === "fire" ? "noted, more like this." : reaction === "later" ? "parked." : "forgotten, permanently.",
      });
      const ack = reaction === "fire" ? "🔥" : reaction === "later" ? "💤" : "🗑 forgotten";
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(ack, "noop") });
      } catch {
        // message may be too old to edit — the reaction is already recorded
      }
      return;
    }

    // Angle chosen → write the full draft in-voice from the chosen angle.
    const ang = /^ang:([0-9a-f-]{36}):(\d)$/.exec(data);
    if (ang) {
      const [, surfacingId, slot] = ang as unknown as [string, string, string];
      await ctx.answerCallbackQuery({ text: "writing it…" });
      await ctx.replyWithChatAction("typing");
      // Resolve the angle by (surfacing, slot) — the button only carries the slot.
      const angle = await queryOne<{ id: string }>(
        `SELECT id FROM angles WHERE surfacing_id = $1 AND user_id = $2 AND slot = $3`,
        [surfacingId, user.id, Number(slot)],
      );
      if (!angle) {
        await ctx.reply("that angle expired, send the idea again and i'll re-offer.");
        return;
      }
      const result = await draftFromAngle(user.id, surfacingId, angle.id);
      if (!result.ok) {
        await ctx.reply(result.note || "couldn't write that one.");
        return;
      }
      // The draft is content for their feed — only the label around it is casual.
      await ctx.reply(`✍️ here you go:\n\n${result.draft}`, {
        reply_markup: new InlineKeyboard().text("🔥 love it", `angfb:${surfacingId}:fire`).text("💤 meh", `angfb:${surfacingId}:later`),
      });
      return;
    }

    // "Turn this into angles" from an in-chat idea → generate + deliver now.
    const mk = /^mkang:([0-9a-f-]{36})$/.exec(data);
    if (mk) {
      const [, momentId] = mk as unknown as [string, string];
      await ctx.answerCallbackQuery({ text: "on it, finding your angles…" });
      await ctx.replyWithChatAction("typing");
      const ok = await maybeOfferAngles({ momentId, userId: user.id }, undefined, { bypassCadence: true });
      if (!ok) await ctx.reply("couldn't spin that one up, try rephrasing the idea.");
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("✨ angles below", "noop") });
      } catch {
        // message too old to edit — fine
      }
      return;
    }

    // A diagnosis "unsaid pattern" tapped → turn it into angles immediately.
    // This is the direct connect → understand taste → narrative ideas hop,
    // without waiting for the full goal/plan flow.
    const dx = /^dxang:([0-9a-f-]{36}):(\d)$/.exec(data);
    if (dx) {
      const [, diagId, idxStr] = dx as unknown as [string, string, string];
      await ctx.answerCallbackQuery({ text: "on it, finding your angles…" });
      const dimensions = await diagnosisById(user.id, diagId);
      const pattern = dimensions?.unsaid_patterns[Number(idxStr)];
      if (!pattern) {
        await ctx.reply("that read's moved on, ask me for a fresh one.");
        return;
      }
      await ctx.replyWithChatAction("typing");
      const momentId = await createIdeaMoment(user.id, pattern.idea, `${pattern.idea}\n\n${pattern.evidence}`);
      const ok = momentId && (await maybeOfferAngles({ momentId, userId: user.id }, undefined, { bypassCadence: true }));
      if (!ok) await ctx.reply("couldn't spin that one up, try again in a moment.");
      return;
    }

    // Repurpose from a stored draft or an outlier capture: rpz:<d|c>:<id>:<x|li>
    const rpz = /^rpz:(d|c):([0-9a-f-]{36}):(x|li)$/.exec(data);
    if (rpz) {
      const [, kind, id, targetRaw] = rpz as unknown as [string, "d" | "c", string, "x" | "li"];
      const target = targetRaw === "li" ? "linkedin" : "x";
      const source =
        kind === "d"
          ? await queryOne<{ text: string }>(`SELECT content AS text FROM drafts WHERE id = $1 AND user_id = $2`, [id, user.id])
          : await queryOne<{ text: string }>(`SELECT raw_text AS text FROM captures WHERE id = $1 AND user_id = $2`, [id, user.id]);
      if (!source?.text) {
        await ctx.answerCallbackQuery({ text: "can't find that content anymore." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "reshaping it…" });
      await ctx.replyWithChatAction("typing");
      const result = await repurposeContent(user.id, {
        mode: "cross_platform",
        target,
        sourceType: kind === "d" ? "draft" : "published_post",
        sourceText: source.text,
        sourceIds: [id],
      });
      await deliverRepurposed(ctxChannel(ctx), result);
      return;
    }

    // Synthesis from a diagnosis unsaid pattern — the loop from "you clearly
    // think this but never wrote it" straight to a written piece.
    const dxsyn = /^dxsyn:([0-9a-f-]{36}):(\d)$/.exec(data);
    if (dxsyn) {
      const [, diagId, idxStr] = dxsyn as unknown as [string, string, string];
      const dimensions = await diagnosisById(user.id, diagId);
      const pattern = dimensions?.unsaid_patterns[Number(idxStr)];
      if (!pattern) {
        await ctx.answerCallbackQuery({ text: "that read's moved on." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "pulling your fragments together…" });
      await ctx.replyWithChatAction("typing");
      const result = await repurposeContent(user.id, {
        mode: "synthesis",
        target: "linkedin",
        sourceType: "memory_cluster",
        theme: `${pattern.idea}. ${pattern.evidence}`,
      });
      await deliverRepurposed(ctxChannel(ctx), result);
      return;
    }

    // Repurposed-content outcome: posted or passed.
    const rpu = /^rpu:([0-9a-f-]{36}):(used|skip)$/.exec(data);
    if (rpu) {
      const [, id, action] = rpu as unknown as [string, string, "used" | "skip"];
      const ack = await recordRepurposeUse(user.id, id, action === "used");
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard().text(action === "used" ? "✅ posted" : "⏭ passed", "noop"),
        });
      } catch {
        // message too old to edit — outcome already recorded
      }
      await ctx.reply(ack);
      return;
    }

    // Reply-draft outcome: sent as-is / sent edited / skipped. Feeds the
    // learned reply threshold and (sent as-is) the capture pipeline.
    const rp = /^rp:([0-9a-f-]{36}):(sent|edited|skip)$/.exec(data);
    if (rp) {
      const [, mentionId, action] = rp as unknown as [string, string, "sent" | "edited" | "skip"];
      const ack = await recordReplyOutcome(user.id, mentionId, action);
      await ctx.answerCallbackQuery();
      const chip = action === "sent" ? "✅ sent" : action === "edited" ? "✏️ sent, edited" : "⏭ skipped";
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(chip, "noop") });
      } catch {
        // message too old to edit — the outcome is already recorded
      }
      await ctx.reply(ack);
      return;
    }

    // Angle-offer feedback → feeds cadence/scoring via the shared surfacing path.
    const angfb = /^angfb:([0-9a-f-]{36}):(fire|later|forget)$/.exec(data);
    if (angfb) {
      const [, surfacingId, reaction] = angfb as unknown as [string, string, "fire" | "later" | "forget"];
      await queryOne(
        `UPDATE surfacings SET user_reaction = $3, reaction_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
        [surfacingId, user.id, reaction],
      );
      await ctx.answerCallbackQuery({ text: reaction === "fire" ? "noted, more like this." : "got it." });
      return;
    }

    // Structural nudge: one-tap voice-profile build (offered when the user
    // crosses the 50-memory threshold without a profile).
    if (data === "nudge:voice") {
      await ctx.answerCallbackQuery({ text: "building it now…" });
      const ent = await entitlementsFor(user.id);
      if (!ent.voiceProfile) {
        await ctx.reply("voice profile's part of the paid tier. /upgrade and i'll build it the moment you're in.");
        return;
      }
      await ctx.replyWithChatAction("typing");
      const r = await buildVoiceProfile(user.id);
      await ctx.reply(
        r.ok
          ? "done. i've got your voice now, and every draft from here sounds like you wrote it on a good day."
          : r.reason,
      );
      return;
    }

    // Billing: generate a Dodo checkout link for the chosen tier.
    const bill = /^bill:(founding|paid)$/.exec(data);
    if (bill) {
      const plan = bill[1] as "founding" | "paid";
      await ctx.answerCallbackQuery({ text: "building your checkout…" });
      try {
        const { url } = await createCheckout(user.id, user.email, plan);
        await ctx.reply(`here's your secure checkout (${plan}):\n${url}`);
      } catch (err) {
        await ctx.reply(err instanceof Error ? `couldn't start checkout: ${err.message}` : "checkout's unavailable right now.");
      }
      return;
    }

    // Stage 4 tone multi-select. Toggles write straight to brand_profiles (its own
    // row — no strategist_state race). "Done" marks the field captured and hands
    // back to the intake for the next question, all inside the per-user turn lock.
    if (data.startsWith("tone:")) {
      const key = data.slice(5);
      if (key === "__done__") {
        await ctx.answerCallbackQuery({ text: "locked in." });
        try {
          await ctx.editMessageReplyMarkup();
        } catch {
          // menu message too old to edit — the selections are already saved
        }
        await runSerializedTurn(user.id, "those are the modes that fit me", ctx, async (_merged, c) => {
          const st = await getState(user.id);
          const cursor = st.profile ?? {};
          const captured = new Set(cursor.captured ?? []);
          captured.add("tone_selections");
          await setState(user.id, { ...st, profile: { ...cursor, captured: [...captured] } });
          await handleTextTurn(user, "those are the modes that fit me", c);
        });
        return;
      }
      if (ALL_TONE_KEYS.includes(key)) {
        const prof = await getProfile(user.id);
        const cur = new Set(prof?.tone_selections ?? []);
        if (cur.has(key)) cur.delete(key);
        else cur.add(key);
        await upsertProfileField(user.id, "tone_selections", [...cur]);
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: toneKeyboard([...cur]) });
        } catch {
          // rapid taps can collide on the edit — the selection is saved regardless
        }
      }
      return void (await ctx.answerCallbackQuery());
    }

    await ctx.answerCallbackQuery();
  });

  // Log errors instead of crashing the process (grammy warns if unset).
  bot.catch((err) => {
    console.error("telegram bot error", err.error);
  });

  // Populate the "/" command menu in Telegram clients.
  void bot.api
    .setMyCommands([
      { command: "start", description: "Set up your profile, then I read your real history" },
      { command: "connect", description: "Connect your X/LinkedIn so I can read your work" },
      { command: "draft", description: "Write a post from your thinking, in your voice" },
      { command: "repurpose", description: "Reshape finished content, or synthesize scattered takes" },
      { command: "peers", description: "Watch a few peers — territory comparison, not a scoreboard" },
      { command: "settings", description: "Quiet hours, timezone, proactive frequency" },
      { command: "upgrade", description: "Unlock paid features" },
      { command: "help", description: "What Yoinky can do" },
    ])
    .catch((err) => console.error("setMyCommands failed", err));

  return bot;
}

/**
 * One full text turn, already serialized per user. Routes between the
 * deterministic connect fast-paths, the paced onboarding session, and the
 * steady-state agentic conversation — with the typing indicator held for the
 * whole turn.
 */
async function handleTextTurn(user: User, text: string, ctx: Context): Promise<void> {
  const channel = ctxChannel(ctx);
  await withTyping(channel, async () => {
    const [state, stage] = await Promise.all([getState(user.id), getStage(user.id)]);

    // "diagnose my x: @handle" typed in plain language must actually SCRAPE that
    // profile, not get answered from whatever's already in memory. But only when
    // it's plausibly THEIR account: an ownership cue ("my", "I'm"), or a user we
    // haven't read yet. "check out @naval on x" from an active user is
    // conversation about someone else — the chat brain handles it (and can still
    // call connect_account after clarifying).
    const intent = detectConnectIntent(text);
    if (intent && (intent.owned || state.awaitingConnect || stage === "new" || stage === "connected")) {
      await beginConnect(ctx, user, intent.platform, intent.handle);
      return;
    }

    // A bare "@handle" is the answer when we just asked for one (/start,
    // /connect help) — and an explicit "@handle" from a brand-new user counts
    // cold. Straight to the scrape + diagnosis, never a goals questionnaire.
    const target = parseConnectTarget(text);
    if (target && (state.awaitingConnect || (target.explicit && stage === "new"))) {
      await beginConnect(ctx, user, target.platform, target.handle);
      return;
    }

    // A brand-new user who leads with a plain thought (not a handle, no /start)
    // still enters the profile intake — profile-first is the default.
    if (stage === "new" && !isOnboardingPhase(state)) {
      await setStage(user.id, "profiling");
      await setState(user.id, { phase: "profiling", profile: {} });
    }

    // In the paced onboarding arc → the LLM-driven strategist session.
    if (isOnboardingPhase(state) || (await getStage(user.id)) === "profiling") {
      try {
        const r = await runSessionTurn(user.id, text);
        await deliverTurnOutput(user, text, r, channel);
        await maybeSendToneMenu(user.id, ctx);
        // A small aside, after the real reply — not competing with it for
        // attention. Only fires the one turn a goal is captured.
        if (r.offerSecondPlatform) {
          const missing = await otherUnconnectedPlatform(user.id).catch(() => null);
          if (missing) {
            await ctx.reply(
              `want me to pull your ${missing === "linkedin" ? "LinkedIn" : "X"} too? different register ` +
                "usually shows up there, worth having both in the picture.",
            );
          }
        }
      } catch (err) {
        console.error("session turn failed", err);
        void import("../lib/alerts.js").then(({ alertAdmin }) =>
          alertAdmin("llm:session-turn", `Onboarding session turn failed — user saw the lost-my-thread line. Error: ${err instanceof Error ? err.message : String(err)}`),
        );
        await ctx.reply("give me a sec, lost my thread there. say that again?");
      }
      return;
    }
    await handleConversation(user, text, channel);
  });
}

const PROFILE_OPENER =
  "before i read a single one of your posts, i want to hear it from you. a handful of real " +
  "questions, then i go read your actual history and show you the gap between what you're trying " +
  "to build and what's already out there. no forms, just talk.\n\n" +
  "first one, easy: what's the broad space you work in?\n\n" +
  "(if you'd rather i just read your history first, say something like \"just diagnose my X @handle\".)";

/** The next uncaptured intake field, computed without importing the session machine (avoids a cycle). */
function nextIntakeField(captured: string[] | undefined): string | undefined {
  const seen = new Set(captured ?? []);
  return PROFILE_FIELDS.find((f) => !seen.has(f));
}

/** The Stage 4 tone taxonomy as a multi-select inline keyboard (✅ marks picks). */
function toneKeyboard(selected: string[]): InlineKeyboard {
  const sel = new Set(selected);
  const kb = new InlineKeyboard();
  for (const cluster of TONE_TAXONOMY) {
    for (const item of cluster.items) {
      kb.text(`${sel.has(item.key) ? "✅ " : ""}${item.label}`, `tone:${item.key}`).row();
    }
  }
  kb.text("✓ done", "tone:__done__");
  return kb;
}

/**
 * When the intake reaches the tone field, offer the taxonomy as tappable buttons
 * (multi-select is far easier than free text here). Sent once per user; the flag
 * lives on strategist_state so it doesn't re-fire each turn.
 */
async function maybeSendToneMenu(userId: string, ctx: Context): Promise<void> {
  const st = await getState(userId);
  if (st.phase !== "profiling" || st.toneMenuSent) return;
  if (nextIntakeField(st.profile?.captured) !== "tone_selections") return;
  const prof = await getProfile(userId);
  await ctx.reply("tap the modes that feel like you (more than one is fine), then hit done:", {
    reply_markup: toneKeyboard(prof?.tone_selections ?? []),
  });
  await setState(userId, { ...st, toneMenuSent: true });
}

/**
 * A full conversational turn with the personal-branding strategist. It reasons
 * over the user's whole body of work (positions, memories, moments, voice),
 * replies in-voice, silently files genuine thoughts, and can execute a tool
 * (draft, repurpose, search, connect, …) it decided the message called for.
 */
async function handleConversation(user: User, text: string, channel: Channel): Promise<void> {
  let result;
  try {
    result = await converseWithUser(user.id, text);
  } catch (err) {
    console.error("conversation failed, filing message as a fallback", err);
    void import("../lib/alerts.js").then(({ alertAdmin }) =>
      alertAdmin("llm:converse-turn", `Conversation turn failed — user saw the glitch line. Error: ${err instanceof Error ? err.message : String(err)}`),
    );
    // Never lose a thought to an LLM error.
    await createCapture({ userId: user.id, source: "telegram_text", rawText: text });
    await saveTurn(user.id, "user", text).catch(() => {});
    await channel.say("filed that, my head glitched for a sec. say more?");
    return;
  }

  await deliverTurnOutput(user, text, result, channel);
}

async function requireUser(ctx: Context): Promise<User | undefined> {
  const tgId = ctx.from?.id;
  if (!tgId) return undefined;
  return findOrCreateUserByTelegram(tgId);
}

/**
 * Fire off a real scrape+diagnose for a handle — thin ctx wrapper over the
 * shared connectAccount executor (also used by the connect_account chat tool).
 */
async function beginConnect(
  ctx: Context,
  user: User,
  platform: "x" | "linkedin",
  handle: string,
): Promise<void> {
  await connectAccount(user, platform, handle, ctxChannel(ctx));
}

/**
 * Detect a "read/diagnose/connect my <platform> <handle>" request typed in plain
 * language (not the /connect command), e.g. "can you do a brand diagnosis on my
 * x: @wtfparry". Requires an actual handle or profile URL plus either a platform
 * word or an intent verb, so it never fires on ordinary chat. Returns null when
 * there's nothing concrete to scrape.
 *
 * `owned` reports whether the message carries a first-person ownership cue
 * ("my x", "read me", "I'm @…"). Callers use it to decide whether the intent
 * may fire for an already-read user — "check out @naval on x" names someone
 * else's account and must go to the chat brain, not the scraper.
 */
export function detectConnectIntent(
  text: string,
): { platform: "x" | "linkedin"; handle: string; owned: boolean } | null {
  const t = text.trim();
  const hasVerb =
    /\b(connect|link|diagnos\w*|analy[sz]\w*|read|scan|scrape|ingest|pull|audit|review|look\s+at|check\s+out)\b/i.test(t);
  const owned = /\b(my|mine|me|myself|i'?m|i\s+am|i'?ve)\b/i.test(t);

  // Profile URLs are unambiguous — take them first.
  const liUrl = t.match(/linkedin\.com\/in\/([^\s/?#]+)/i);
  if (liUrl?.[1]) return { platform: "linkedin", handle: liUrl[1], owned };
  const xUrl = t.match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i);
  if (xUrl?.[1] && !/\/(home|search|explore|i|messages|notifications)\b/i.test(t)) {
    return { platform: "x", handle: xUrl[1], owned };
  }

  const platform: "x" | "linkedin" | null = /\blinked\s?in\b/i.test(t)
    ? "linkedin"
    : /\b(twitter|x)\b/i.test(t)
      ? "x"
      : null;
  const at = t.match(/@([A-Za-z0-9_]{2,30})/);
  if (platform && at?.[1] && hasVerb) return { platform, handle: at[1], owned };
  return null;
}

/** Ordinary chat words that happen to be valid handle shapes — never scrape these bare. */
const NOT_A_HANDLE = new Set([
  "hi", "hey", "hello", "yo", "sup", "yes", "no", "ok", "okay", "thanks", "thank",
  "sure", "cool", "nice", "great", "what", "why", "how", "help", "start", "stop",
  "test", "hmm", "lol", "haha", "done", "wait", "later", "maybe", "please",
]);

/**
 * Parse a message that IS a handle — the reply to "send me your handle".
 * Accepts "@wtfparry", a profile URL, "x wtfparry" / "linkedin <url>", or a
 * bare "wtfparry". Bare handles default to X (LinkedIn is a URL/slug in
 * practice). `explicit` is true when the message carries clear connect intent
 * (@-prefix, URL, or platform word) — callers require it outside of a direct
 * "what's your handle?" exchange, so "hello" never gets scraped.
 */
export function parseConnectTarget(
  text: string,
): { platform: "x" | "linkedin"; handle: string; explicit: boolean } | null {
  const t = text.trim();
  const viaIntent = detectConnectIntent(t);
  if (viaIntent) return { platform: viaIntent.platform, handle: viaIntent.handle, explicit: true };

  const li = t.match(/^(?:linkedin\s*:?\s+)?(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([^\s/?#]+)\/?$/i);
  if (li?.[1]) return { platform: "linkedin", handle: li[1], explicit: true };

  // Lenient short form: a message of ≤6 words naming a platform with one
  // @handle in it — "x: @wtfparry", "my x is @wtfparry", "on twitter @foo".
  if (t.split(/\s+/).length <= 6) {
    const plat = /\blinked\s?in\b/i.test(t) ? "linkedin" : /\b(twitter|x)\b/i.test(t) ? "x" : null;
    const at = t.match(/@([A-Za-z0-9_]{2,30})/);
    if (plat && at?.[1]) return { platform: plat, handle: at[1], explicit: true };
  }

  const m = t.match(/^(?:(x|twitter|linkedin)\s*:?\s+)?(@?)([A-Za-z0-9_][A-Za-z0-9_.-]{1,29})$/i);
  if (!m?.[3]) return null;
  const platform = m[1]?.toLowerCase() === "linkedin" ? "linkedin" : "x";
  const handle = m[3];
  const explicit = Boolean(m[1] || m[2]); // platform word or @-prefix
  if (!explicit && NOT_A_HANDLE.has(handle.toLowerCase())) return null;
  // X handles are 1-15 chars of word characters; don't guess on anything longer.
  if (platform === "x" && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  return { platform, handle, explicit };
}

export function reactionKeyboard(surfacingId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔥 useful", `rx:${surfacingId}:fire`)
    .text("💤 not now", `rx:${surfacingId}:later`)
    .text("🗑 forget", `rx:${surfacingId}:forget`);
}

/**
 * Resurfacing's keyboard: the standard reaction row, plus — since angle-offering
 * now folds into resurfacing rather than running its own separate hourly scan —
 * a second row offering to turn the resurfaced idea straight into angles.
 */
export function resurfaceKeyboard(surfacingId: string, momentId: string | null): InlineKeyboard {
  const kb = reactionKeyboard(surfacingId);
  if (momentId) kb.row().text("✍️ turn into angles", `mkang:${momentId}`);
  return kb;
}

/**
 * Deliver a proactive DM. Pass `surfacingId` for the default 🔥/💤/🗑 reaction
 * keyboard, or `keyboard` for a custom one (e.g. angle "Write #N" buttons).
 */
export async function sendTelegram(
  userId: string,
  text: string,
  surfacingId?: string,
  keyboard?: InlineKeyboard,
): Promise<boolean> {
  if (!bot) return false;
  const user = await queryOne<{ telegram_id: string | null }>(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [userId],
  );
  if (!user?.telegram_id) return false;
  const reply_markup = keyboard ?? (surfacingId ? reactionKeyboard(surfacingId) : undefined);
  await bot.api.sendMessage(Number(user.telegram_id), text, { reply_markup });
  return true;
}

/**
 * Deliver a sequence of DMs as one paced walkthrough (used for the diagnosis
 * reveal): a typing indicator and a short beat between each message so it reads
 * like a strategist talking, not a wall of text dumped at once.
 */
export async function sendTelegramSequence(userId: string, messages: string[]): Promise<boolean> {
  if (!bot) return false;
  const user = await queryOne<{ telegram_id: string | null }>(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [userId],
  );
  if (!user?.telegram_id) return false;
  const chatId = Number(user.telegram_id);
  for (let i = 0; i < messages.length; i++) {
    // These sequences are always Yoinky speaking (diagnosis/gap/plan reveals,
    // progress reads), never content for the user's feed — so the casual opener
    // backstop is safe to apply here.
    const text = casualize(messages[i] ?? "");
    if (!text) continue;
    if (i > 0) {
      await bot.api.sendChatAction(chatId, "typing").catch(() => {});
      await new Promise((r) => setTimeout(r, 1400));
    }
    await bot.api.sendMessage(chatId, text);
  }
  return true;
}
