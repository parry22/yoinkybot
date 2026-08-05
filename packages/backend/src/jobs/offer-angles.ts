import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { query, queryOne } from "../db/pool.js";
import type { OfferAnglesJob } from "./boss.js";
import { llmCall } from "../llm/gateway.js";
import { generateAngles } from "../prompts/generate-angles.v1.js";
import { canDeliverProactive } from "../surfacing/cadence.js";
import { type UserSettings } from "../lib/time.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { sendTelegram } from "../telegram/bot.js";

const anglesSchema = z.object({
  angles: z
    .array(
      z.object({
        label: z.string(),
        angle: z.string(),
        hook: z.string(),
        why_it_lands: z.string().default(""),
      }),
    )
    .min(1),
});

/**
 * Create an ad-hoc "shareable" moment from an idea that didn't come through
 * ambient capture (a chat-derived thought, or a diagnosis unsaid-pattern) so it
 * can flow through the same angle-offer path as everything else.
 */
export async function createIdeaMoment(userId: string, title: string, text: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO moments (user_id, profile_id, kind, title, excerpt, shareability, verdict, gated_at)
     VALUES ($1,$1,'compose',$2,$3,0.9,'shareable', now()) RETURNING id`,
    [userId, title.length > 200 ? title.slice(0, 197) + "…" : title, text],
  );
  return row?.id ?? null;
}

interface MomentRow {
  id: string;
  kind: string;
  title: string | null;
  url: string | null;
  excerpt: string;
  shareability: number;
  theme: string | null;
  why_now: string | null;
}

export async function maybeOfferAngles(
  job: OfferAnglesJob,
  settings?: UserSettings,
  opts?: { bypassCadence?: boolean },
): Promise<boolean> {
  const userSettings =
    settings ??
    (await queryOne<{ settings: UserSettings }>(`SELECT settings FROM users WHERE id = $1`, [job.userId]))?.settings ??
    {};

  // Shared proactive budget across resurface / angle_offer / trend_match. Skipped
  // when the user explicitly asked for angles right now (in-chat button).
  if (!opts?.bypassCadence) {
    const cadence = await canDeliverProactive(job.userId, userSettings);
    if (!cadence.ok) return false;
  }

  // Pick the moment: a specific one (from the gate) if still un-angled, else the
  // best shareable, not-yet-angled moment for this user.
  const momentCols = `id, kind, title, url, excerpt, shareability,
         signals->>'theme' AS theme, signals->>'why_now' AS why_now`;
  const moment = job.momentId
    ? await queryOne<MomentRow>(
        `SELECT ${momentCols} FROM moments WHERE id = $1 AND user_id = $2 AND verdict = 'shareable'`,
        [job.momentId, job.userId],
      )
    : await queryOne<MomentRow>(
        `SELECT ${momentCols} FROM moments
         WHERE user_id = $1 AND verdict = 'shareable'
         ORDER BY shareability DESC, created_at DESC LIMIT 1`,
        [job.userId],
      );
  if (!moment) return false;

  const positions = await query<{ statement: string }>(
    `SELECT statement FROM positions WHERE user_id = $1 AND status = 'active' ORDER BY last_affirmed_at DESC LIMIT 15`,
    [job.userId],
  );
  const profile = await currentVoiceProfile(job.userId);

  const res = await llmCall({
    userId: job.userId,
    eventType: "angles",
    tier: generateAngles.tier,
    system: generateAngles.system,
    user: generateAngles.render({
      subject: moment.excerpt,
      subjectKind: moment.kind === "trend" ? "trend" : "moment",
      title: moment.title ?? "",
      url: moment.url ?? "",
      positions: positions.map((p) => p.statement),
      voiceTraits: profile?.traits,
    }),
    json: true,
    maxTokens: 1024,
  });
  const parsed = anglesSchema.parse(res.parsed);
  const angles = parsed.angles.slice(0, 3);

  // Record the surfacing + angle rows.
  const surfacing = await queryOne<{ id: string }>(
    `INSERT INTO surfacings (user_id, memory_ids, type, payload, channel, moment_id)
     VALUES ($1, '{}', 'angle_offer', $2, 'telegram', $3) RETURNING id`,
    [job.userId, JSON.stringify({ title: moment.title, url: moment.url, theme: moment.theme, angles }), moment.id],
  );
  if (!surfacing) return false;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i]!;
    await queryOne<{ id: string }>(
      `INSERT INTO angles (user_id, surfacing_id, moment_id, slot, label, angle, hook, why_it_lands)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [job.userId, surfacing.id, moment.id, i + 1, a.label, a.angle, a.hook, a.why_it_lands],
    );
    // Callback data is capped at 64 bytes by Telegram - reference the angle by
    // slot (1-3), not its UUID, so `ang:<surfacingId>:<slot>` stays well under.
    keyboard.text(`write #${i + 1}`, `ang:${surfacing.id}:${i + 1}`);
  }
  keyboard.row().text("💤 not now", `angfb:${surfacing.id}:later`);

  // The offer now exists (surfacing + angles recorded, visible in the web
  // dashboard too), so mark the moment angled regardless of Telegram delivery -
  // otherwise the hourly tick would regenerate angles and burn LLM calls.
  await query(`UPDATE moments SET verdict = 'angled' WHERE id = $1`, [moment.id]);

  // Trend offers get the rare, premium treatment; browsing moments stay casual.
  const lead =
    moment.kind === "trend"
      ? `🎯 the conversation came to you: "${moment.title ?? "a live discussion"}" is trending right now${moment.why_now ? `, ${moment.why_now}` : ""}.`
      : moment.title
        ? `you spent time on "${moment.title}".`
        : "something you saved is worth a post.";
  const body = angles.map((a, i) => `${i + 1}) ${a.label}: ${a.hook}`).join("\n");
  const message = `${lead} here are 3 ways to tell this story:\n\n${body}`;

  return sendTelegram(job.userId, message, undefined, keyboard);
}
