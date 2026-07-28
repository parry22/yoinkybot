import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { query, queryOne } from "../db/pool.js";
import { config } from "../config.js";
import { llmCall } from "../llm/gateway.js";
import { pullXMentions } from "../capture/imports/twitterapi-io.js";
import { classifyMention } from "../prompts/classify-mention.v1.js";
import { enforceStyle } from "../prompts/style.js";
import { activePositions } from "../memory/positions.js";
import { draftReplyWithAgent } from "./reply-agent.js";
import { createCapture } from "../capture/service.js";
import { sendTelegram } from "../telegram/bot.js";
import type { UserSettings } from "../lib/time.js";
import {
  reachScore,
  relationshipStrength,
  replyWorthyScore,
  learnedThreshold,
  pickNextMention,
} from "./scoring.js";
import { runAsUser } from "../byok/context.js";

/** Replies to mentions older than this read as weird — never surface them. */
const MAX_MENTION_AGE_DAYS = 7;

/** Reputation alerts override the weekly delivery budget, so cap them separately. */
const WEEKLY_REPUTATION_CAP = 2;

const classificationSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]).catch("neutral"),
  is_question: z.boolean().catch(false),
  is_substantive_challenge: z.boolean().catch(false),
});

// ── Ingestion (cron, every few hours — no delivery here) ─────────────────────

/** Sweep all users with a connected X account; public mentions only, DMs never. */
export async function handleMentionsFetch(): Promise<void> {
  if (!config.TWITTERAPI_IO_KEY) return;
  const users = await query<{ user_id: string; handle: string }>(
    `SELECT ca.user_id, ca.handle FROM connected_accounts ca
     JOIN users u ON u.id = ca.user_id
     WHERE ca.platform = 'x' AND ca.status = 'ingested' AND u.telegram_id IS NOT NULL`,
  );
  for (const u of users) {
    try {
      // BYOK: everything under here resolves this user's own scraper key
      // (byok/context.ts). Wrapping the per-user loop body is what makes the
      // whole ingestion/search tree below inherit it without threading an id.
      await runAsUser(u.user_id, () => ingestMentionsForUser(u.user_id, u.handle));
    } catch (err) {
      console.error(`mentions fetch failed for ${u.user_id}`, err);
    }
  }
}

/**
 * Pull recent public mentions, classify only the genuinely new ones (cheap
 * tier, one call each), and score them deterministically. The model classifies
 * signals; it never decides what deserves attention.
 */
export async function ingestMentionsForUser(userId: string, handle: string): Promise<number> {
  const mentions = await pullXMentions(handle);
  const positions = (await activePositions(userId)).map((p) => p.statement);
  let stored = 0;

  for (const m of mentions) {
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO mentions (user_id, platform, external_id, url, author_handle, author_reach, content, posted_at)
       VALUES ($1,'x',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, platform, external_id) DO NOTHING
       RETURNING id`,
      [userId, m.externalId, m.url, m.authorHandle, m.authorReach, m.content, m.postedAt],
    );
    if (!inserted) continue; // already seen

    // Classify signals; on model failure degrade to a plain regex read rather than dropping the mention.
    let signals = { sentiment: "neutral" as string, is_question: /\?/.test(m.content), is_substantive_challenge: false };
    try {
      const res = await llmCall({
        userId,
        eventType: "classify_mention",
        // High-volume, low-stakes classification — the cheap floor per the model registry.
        tier: "cheap_floor",
        system: classifyMention.system,
        user: classifyMention.render({ content: m.content, authorHandle: m.authorHandle, userHandle: handle, positions }),
        json: true,
        maxTokens: 80,
      });
      signals = classificationSchema.parse(res.parsed);
    } catch (err) {
      console.error("mention classification failed; using regex fallback", err);
    }

    // Relationship from real interaction history (stands in for a connections graph).
    const hist = await queryOne<{ prior: string; replies: string }>(
      `SELECT
         (SELECT count(*) FROM mentions WHERE user_id = $1 AND author_handle = $2 AND id <> $3)::text AS prior,
         (SELECT count(*) FROM sent_replies sr JOIN mentions mm ON mm.id = sr.mention_id
          WHERE sr.user_id = $1 AND mm.author_handle = $2)::text AS replies`,
      [userId, m.authorHandle, inserted.id],
    );
    const relationship = relationshipStrength(Number(hist?.prior ?? 0), Number(hist?.replies ?? 0));

    const score = replyWorthyScore({
      reach01: reachScore(m.authorReach),
      isQuestion: signals.is_question,
      isSubstantiveChallenge: signals.is_substantive_challenge,
      relationship,
    });

    await query(
      `UPDATE mentions SET sentiment=$2, is_question=$3, is_substantive_challenge=$4,
         relationship_strength=$5, reply_worthy_score=$6 WHERE id = $1`,
      [inserted.id, signals.sentiment, signals.is_question, signals.is_substantive_challenge, relationship, score],
    );
    stored++;

    // Reputation lens: negative sentiment from genuinely high reach is the one
    // thing that overrides the delivery budget — but at most once a day, and
    // stated factually, never as a panic.
    if (signals.sentiment === "negative" && reachScore(m.authorReach) >= 0.5) {
      await maybeReputationAlert(userId, {
        author: m.authorHandle,
        reach: m.authorReach,
        content: m.content,
        url: m.url,
        mentionId: inserted.id,
      });
    }
  }
  return stored;
}

/** Are alerts about comments/mentions on the user's own posts silenced? OFF by
 *  DEFAULT for every user (they're noise most people don't want) — only delivered
 *  when a user explicitly opts in with `/settings mentions on`. */
async function mentionAlertsSilenced(userId: string): Promise<boolean> {
  const row = await queryOne<{ settings: UserSettings }>(`SELECT settings FROM users WHERE id = $1`, [userId]);
  return row?.settings?.mention_alerts !== true;
}

async function maybeReputationAlert(
  userId: string,
  m: { author: string; reach: number; content: string; url: string | null; mentionId: string },
): Promise<void> {
  if (await mentionAlertsSilenced(userId)) return; // user opted out of comment/mention alerts
  // Reputation alerts are the one message allowed to override the shared weekly
  // delivery budget — but that override must itself be bounded, or a bad news
  // cycle turns into up to seven surprise DMs a week. At most one a day AND at
  // most WEEKLY_REPUTATION_CAP a rolling week.
  const recent = await queryOne<{ day: string; week: string }>(
    `SELECT
       count(*) FILTER (WHERE delivered_at > now() - interval '24 hours')::text AS day,
       count(*) FILTER (WHERE delivered_at > now() - interval '7 days')::text AS week
     FROM surfacings
     WHERE user_id = $1 AND type = 'reputation_alert'`,
    [userId],
  );
  if (Number(recent?.day ?? 0) > 0 || Number(recent?.week ?? 0) >= WEEKLY_REPUTATION_CAP) return;

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'reputation_alert', $2, 'telegram') RETURNING id`,
    [userId, JSON.stringify({ mention_id: m.mentionId, author: m.author, reach: m.reach })],
  );
  if (!surfacing) return;
  const sent = await sendTelegram(
    userId,
    `Worth seeing now rather than later: @${m.author} (${m.reach.toLocaleString()} followers) posted this about you:\n\n` +
      `"${m.content.slice(0, 300)}"${m.url ? `\n${m.url}` : ""}\n\n` +
      `No action needed from me unless you want it. If it's reply-worthy, a draft will come through the normal path.`,
  ).catch(() => false);
  // If it didn't land, drop the row so it doesn't consume the daily/weekly
  // reputation slot and silence the next genuine alert.
  if (!sent) await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
}

// ── Delivery (called from the proactive tick, ahead of resurfacing) ──────────

/**
 * Surface at most ONE reply draft: the highest-priority mention above the
 * user's learned threshold (challenges first, then questions, then score).
 * Caller has already cleared the shared proactive budget. Others that also
 * clear the bar simply wait for a future slot — a queue, never a batch.
 */
export async function maybeOfferReplyDraft(userId: string): Promise<boolean> {
  if (await mentionAlertsSilenced(userId)) return false; // user opted out of reply-draft offers on their posts
  const outcomes = await query<{ score: number; status: "sent" | "skipped" }>(
    `SELECT reply_worthy_score AS score, reply_status AS status FROM mentions
     WHERE user_id = $1 AND reply_status IN ('sent','skipped')
     ORDER BY reply_drafted_at DESC NULLS LAST LIMIT 20`,
    [userId],
  );
  const threshold = learnedThreshold(outcomes);

  const candidates = await query<{
    id: string;
    author_handle: string;
    content: string;
    url: string | null;
    is_question: boolean;
    is_substantive_challenge: boolean;
    relationship_strength: number;
    reply_worthy_score: number;
  }>(
    `SELECT id, author_handle, content, url, is_question, is_substantive_challenge,
            relationship_strength, reply_worthy_score
     FROM mentions
     WHERE user_id = $1 AND reply_status = 'none'
       AND reply_worthy_score >= $2
       AND posted_at > now() - make_interval(days => $3)`,
    [userId, threshold, MAX_MENTION_AGE_DAYS],
  );
  const pick = pickNextMention(
    candidates.map((c) => ({
      ...c,
      isSubstantiveChallenge: c.is_substantive_challenge,
      isQuestion: c.is_question,
      score: c.reply_worthy_score,
    })),
  );
  if (!pick) return false;

  const reasons = [
    ...(pick.is_substantive_challenge ? ["substantive challenge to a stated position"] : []),
    ...(pick.is_question ? ["direct question"] : []),
    ...(pick.relationship_strength >= 0.3 ? ["real back-and-forth history with this person"] : []),
  ];
  if (reasons.length === 0) reasons.push("high-reach mention");

  const hist = await queryOne<{ prior: string; replies: string }>(
    `SELECT
       (SELECT count(*) FROM mentions WHERE user_id = $1 AND author_handle = $2 AND id <> $3)::text AS prior,
       (SELECT count(*) FROM sent_replies sr JOIN mentions mm ON mm.id = sr.mention_id
        WHERE sr.user_id = $1 AND mm.author_handle = $2)::text AS replies`,
    [userId, pick.author_handle, pick.id],
  );

  const postedAt = await queryOne<{ external_id: string; posted_at: string }>(
    `SELECT external_id, posted_at::text FROM mentions WHERE id = $1`,
    [pick.id],
  );

  // Agentic drafting (reply-draft.v2): the model pulls its own grounding
  // (memory, voice, pillars, thread, visibility facts) inside a bounded loop.
  // Selection stayed above, in code.
  const agent = await draftReplyWithAgent(
    userId,
    {
      id: pick.id,
      externalId: postedAt?.external_id ?? "",
      authorHandle: pick.author_handle,
      content: pick.content,
      url: pick.url,
      postedAt: postedAt?.posted_at ? new Date(postedAt.posted_at) : new Date(),
    },
    reasons,
    { priorMentions: Number(hist?.prior ?? 0), repliesSent: Number(hist?.replies ?? 0) },
  );
  const draft = enforceStyle(agent.draft);

  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel)
     VALUES ($1, '{}', 'reply_draft', $2, 'telegram') RETURNING id`,
    [
      userId,
      JSON.stringify({
        mention_id: pick.id,
        intro: agent.intro,
        draft,
        reasons,
        score: pick.reply_worthy_score,
        cited_memory_ids: agent.citedMemoryIds,
        distribution_rationale: agent.distributionRationale,
        agent_steps: agent.steps.map((s) => ({ tool: s.tool, args: s.args })),
      }),
    ],
  );
  if (!surfacing) return false;

  await query(`UPDATE mentions SET reply_status='drafted', draft_text=$2, reply_drafted_at=now() WHERE id = $1`, [
    pick.id,
    draft,
  ]);

  const message =
    `${agent.intro}\n\nHere's a draft if you want to reply:\n\n"${draft}"\n\n` +
    `Copy it, tweak it, or skip it.${pick.url ? `\n${pick.url}` : ""}`;
  const kb = new InlineKeyboard()
    .text("✅ sent it", `rp:${pick.id}:sent`)
    .text("✏️ sent, edited", `rp:${pick.id}:edited`)
    .row()
    .text("⏭ skip", `rp:${pick.id}:skip`);
  const sent = await sendTelegram(userId, message, undefined, kb);
  if (!sent) {
    // Delivery failed — don't leave a phantom surfacing row that counts against
    // the budget and shows as history for a message that never arrived.
    await query(`DELETE FROM surfacings WHERE id = $1`, [surfacing.id]);
    await query(`UPDATE mentions SET reply_status='none', draft_text=NULL, reply_drafted_at=NULL WHERE id = $1`, [pick.id]);
    return false;
  }
  return true;
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export type ReplyAction = "sent" | "edited" | "skip";

/**
 * Record what the user did with a draft. Sent (either way) logs into
 * sent_replies; edited_before_send is the voice-tuning signal, skips are the
 * filtering signal — the two failure modes stay separate. A reply sent AS-IS is
 * genuine public output in their voice, so it enters the standard capture
 * pipeline and feeds the voice profile and diagnosis like any original post.
 * (Edited sends aren't captured — we'd be storing OUR text, not what they
 * actually posted.)
 */
export async function recordReplyOutcome(userId: string, mentionId: string, action: ReplyAction): Promise<string> {
  const mention = await queryOne<{ id: string; draft_text: string | null; platform: string; url: string | null; reply_status: string }>(
    `SELECT id, draft_text, platform, url, reply_status FROM mentions WHERE id = $1 AND user_id = $2`,
    [mentionId, userId],
  );
  if (!mention || mention.reply_status !== "drafted") return "That one's already handled.";

  if (action === "skip") {
    await query(`UPDATE mentions SET reply_status='skipped' WHERE id = $1`, [mentionId]);
    return "Skipped. I'll factor that into what I bring you.";
  }

  const edited = action === "edited";
  await query(`UPDATE mentions SET reply_status='sent', reply_sent_at=now() WHERE id = $1`, [mentionId]);
  await query(
    `INSERT INTO sent_replies (mention_id, user_id, draft_text, edited_before_send) VALUES ($1,$2,$3,$4)`,
    [mentionId, userId, mention.draft_text ?? "", edited],
  );
  if (!edited && mention.draft_text) {
    await createCapture({
      userId,
      source: mention.platform === "linkedin" ? "linkedin_import" : "x_import",
      rawText: mention.draft_text,
      metadata: { published: true, reply_to_mention: mentionId, url: mention.url },
    });
  }
  return edited
    ? "Logged. Noting that you reworked it — that tunes how I draft for you."
    : "Logged as sent. It'll feed your voice profile like any of your posts.";
}
