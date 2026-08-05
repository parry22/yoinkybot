import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { draftPostV2 } from "../prompts/draft.v2.js";
import { draftEvidence, EMPTY_EVIDENCE } from "./evidence.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { markUnlockDeveloped } from "../strategist/plan.js";
import { enforceStyle } from "../prompts/style.js";

const draftSchema = z.object({
  draft: z.string(),
  source_memory_ids: z.array(z.string()).default([]),
  media_suggestion: z.string().default(""),
  note: z.string().default(""),
});

export interface AngleDraftResult {
  ok: boolean;
  draft: string;
  note: string;
  /** One concrete visual to pair with the post for reach, or "" if none fits. */
  mediaSuggestion: string;
}

/**
 * Draft a full post from a chosen narrative angle. Unlike cold `generateDraft`,
 * this is grounded by the angle + its source moment/trend, so it does NOT require
 * a mature (50-memory) voice profile - the moment IS the substance. Voice traits
 * are used when available, otherwise the model writes in a clean first-person voice.
 */
export async function draftFromAngle(
  userId: string,
  surfacingId: string,
  angleId: string,
  platform: "x" | "linkedin" = "x",
): Promise<AngleDraftResult> {
  const ent = await entitlementsFor(userId);
  if (!ent.drafting) {
    return { ok: false, draft: "", note: "Drafting is a paid feature - upgrade to have Yoinky write it for you.", mediaSuggestion: "" };
  }

  const angle = await queryOne<{
    id: string;
    angle: string;
    hook: string;
    label: string;
    moment_id: string | null;
    trend_id: string | null;
  }>(
    `SELECT id, angle, hook, label, moment_id, trend_id FROM angles WHERE id = $1 AND user_id = $2 AND surfacing_id = $3`,
    [angleId, userId, surfacingId],
  );
  if (!angle) return { ok: false, draft: "", note: "That angle expired.", mediaSuggestion: "" };

  // Anchor text: the moment excerpt or the trend summary the angle is about.
  let anchor = "";
  if (angle.moment_id) {
    const m = await queryOne<{ excerpt: string; title: string | null }>(
      `SELECT excerpt, title FROM moments WHERE id = $1`,
      [angle.moment_id],
    );
    if (m) anchor = `${m.title ? m.title + "\n" : ""}${m.excerpt}`;
  } else if (angle.trend_id) {
    const t = await queryOne<{ topic: string; summary: string }>(
      `SELECT topic, summary FROM trends WHERE id = $1`,
      [angle.trend_id],
    );
    if (t) anchor = `${t.topic}\n${t.summary}`;
  }

  // Pull any supporting memories on the angle's topic (may be empty for new users).
  const memories = await hybridSearch(userId, `${angle.angle} ${angle.hook}`, 8);
  const grounding = [
    { id: `angle:${angle.id}`, content: `ANGLE - ${angle.label}: ${angle.angle}\nHook: ${angle.hook}`, kind: "angle" },
    ...(anchor ? [{ id: `moment:${angle.moment_id ?? angle.trend_id}`, content: anchor, kind: "source" }] : []),
    ...memories.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
  ];

  const [profile, evidence] = await Promise.all([
    currentVoiceProfile(userId),
    // Same measured evidence the main draft path gets - an angle-draft is still a
    // post going out under their name, so it should know what lands for them.
    draftEvidence(userId).catch(() => EMPTY_EVIDENCE),
  ]);
  const voiceTraits = profile?.traits ?? { note: "No voice profile yet - write in a clear, natural first-person voice; avoid generic AI phrasing." };

  const res = await llmCall({
    userId,
    eventType: "draft",
    tier: draftPostV2.tier,
    system: draftPostV2.system,
    user: draftPostV2.render({
      request: `Write this post using the chosen angle. Platform: ${platform}.`,
      platform,
      memories: grounding,
      voiceTraits,
      evidence,
    }),
    json: true,
    maxTokens: 1200,
  });
  const parsed = draftSchema.parse(res.parsed);
  if (!parsed.draft) return { ok: false, draft: "", note: parsed.note || "Couldn't produce a draft from that angle.", mediaSuggestion: "" };
  const draft = enforceStyle(parsed.draft);

  // Persist the draft and link it back to the angle.
  const draftRow = await queryOne<{ id: string }>(
    `INSERT INTO drafts (user_id, content, platform, source_memory_ids, angle_id, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      userId,
      draft,
      platform,
      parsed.source_memory_ids.filter((s) => /^[0-9a-f-]{36}$/.test(s)),
      angle.id,
      parsed.note,
    ],
  );
  await query(`UPDATE angles SET chosen = true, draft_id = $2 WHERE id = $1`, [angle.id, draftRow?.id ?? null]);
  // If this draft develops a pending unlock-list idea, close the loop.
  await markUnlockDeveloped(userId, draft, draftRow?.id).catch(() => {});

  return { ok: true, draft, note: parsed.note, mediaSuggestion: parsed.media_suggestion };
}
