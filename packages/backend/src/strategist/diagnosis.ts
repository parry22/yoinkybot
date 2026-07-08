import { z } from "zod";
import { InlineKeyboard } from "grammy";
import { query, queryOne } from "../db/pool.js";
import { getBoss, QUEUES, type DiagnoseJob } from "../jobs/boss.js";
import { llmCall } from "../llm/gateway.js";
import { diagnosis as diagnosisPrompt } from "../prompts/diagnosis.v1.js";
import { activePositions } from "../memory/positions.js";
import { currentVoiceProfile, buildVoiceProfile, VOICE_MIN_MEMORIES } from "../voice/profile.js";
import { computeEvidence } from "./evidence.js";
import { lintDiagnosis, violationInstruction } from "./diagnosis-lint.js";
import { sendTelegram } from "../telegram/bot.js";
import { openSession } from "./session-machine.js";

const MAX_READINESS_ATTEMPTS = 20; // ~10 min of 30s re-checks
// Fires the one honesty check-in once total wait (pull time + this polling)
// crosses roughly 2.5 minutes, so silence never reads as "broken" on a big profile.
const SLOW_PING_ATTEMPT = 3;
const SAMPLE_SIZE = 140;

export const diagnosisSchema = z.object({
  headline: z.string(),
  intellectual_fingerprint: z.object({
    read: z.string(),
    owned_positions: z.array(z.string()).default([]),
    latent_beliefs: z.array(z.string()).default([]),
  }),
  voice_signature: z.object({ read: z.string(), drift: z.string().default("") }),
  outside_in_gap: z.object({ read: z.string(), missed_swings: z.array(z.string()).default([]) }),
  consistency_audit: z.array(z.object({ tension: z.string(), why_interesting: z.string() })).default([]),
  unsaid_patterns: z.array(z.object({ idea: z.string(), evidence: z.string() })).default([]),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

/** Ingestion is "complete" only when nothing is still being extracted/embedded. */
async function ingestionPending(userId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM captures WHERE user_id = $1 AND status IN ('pending','transcribing','extracting','gating'))
       + (SELECT count(*) FROM memories WHERE user_id = $1 AND status = 'active' AND embedding IS NULL)
     )::text AS n`,
    [userId],
  );
  return Number(row?.n ?? 0) > 0;
}

export async function handleDiagnose(job: DiagnoseJob): Promise<void> {
  const attempt = job.attempt ?? 0;

  // Never diagnose on a partial read — wait for extraction to finish (bounded).
  if ((await ingestionPending(job.userId)) && attempt < MAX_READINESS_ATTEMPTS) {
    // One honesty check-in on a big profile so silence reads as "working", not
    // "broken" — fires once, never repeats on subsequent re-checks.
    if (attempt === SLOW_PING_ATTEMPT && !job.pingedSlow) {
      await sendTelegram(job.userId, "Still reading, you've posted a lot. Almost through it.").catch(() => {});
    }
    await getBoss().send(
      QUEUES.diagnose,
      { userId: job.userId, attempt: attempt + 1, pingedSlow: job.pingedSlow || attempt === SLOW_PING_ATTEMPT },
      { startAfter: 30 },
    );
    return;
  }

  await runDiagnosis(job.userId, { deliver: true });
}

/** Generate + store the diagnosis. When `deliver`, opens the paced strategist session. */
export async function runDiagnosis(
  userId: string,
  opts: { deliver?: boolean } = {},
): Promise<Diagnosis | null> {
  // A representative spread of their history: most recent + oldest, capped.
  const posts = await query<{ content: string; kind: string; created_at: string; source: string }>(
    `(SELECT m.content, m.kind, m.created_at::text, COALESCE(c.source,'capture') AS source
      FROM memories m LEFT JOIN captures c ON c.id = m.capture_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY m.created_at DESC LIMIT $2)
     UNION
     (SELECT m.content, m.kind, m.created_at::text, COALESCE(c.source,'capture') AS source
      FROM memories m LEFT JOIN captures c ON c.id = m.capture_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY m.created_at ASC LIMIT 40)`,
    [userId, SAMPLE_SIZE],
  );
  if (posts.length < 3) {
    if (opts.deliver) {
      await sendTelegram(
        userId,
        "I don't have enough of your thinking yet to give you a real diagnosis — connect an account or send me a few posts' worth of takes first. A shallow read would just waste your time.",
      );
    }
    return null;
  }

  const [positions, profile, countRow, evidence] = await Promise.all([
    activePositions(userId),
    currentVoiceProfile(userId),
    queryOne<{ n: string }>(`SELECT count(*)::text n FROM memories WHERE user_id = $1 AND status = 'active'`, [userId]),
    computeEvidence(userId),
  ]);
  const memoryCount = Number(countRow?.n ?? posts.length);

  const rendered = diagnosisPrompt.render({
    posts: posts.slice(0, SAMPLE_SIZE),
    positions: positions.map((p) => p.statement),
    voiceTraits: profile?.traits,
    memoryCount,
    evidence: evidence.text,
  });
  const generate = async (user: string) => {
    const res = await llmCall({
      userId,
      eventType: "diagnosis",
      tier: diagnosisPrompt.tier,
      system: diagnosisPrompt.system,
      user,
      json: true,
      maxTokens: 2500,
    });
    return diagnosisSchema.parse(res.parsed);
  };

  // Quality gate: lint against the spec (language + groundedness rules); one
  // corrective retry on violations, then take whichever draft is cleaner.
  let parsed = await generate(rendered);
  let violations = lintDiagnosis(parsed);
  if (violations.length > 0) {
    console.warn(`diagnosis lint: ${violations.length} violation(s), retrying once`, violations.map((x) => x.rule));
    try {
      const retry = await generate(`${rendered}\n\n${violationInstruction(violations)}`);
      const retryViolations = lintDiagnosis(retry);
      if (retryViolations.length < violations.length) {
        parsed = retry;
        violations = retryViolations;
      }
    } catch (err) {
      console.error("diagnosis lint retry failed; keeping first draft", err);
    }
    if (violations.length > 0) {
      console.warn(`diagnosis delivered with ${violations.length} residual lint violation(s)`, violations);
    }
  }

  const prev = await queryOne<{ version: number }>(
    `SELECT max(version) AS version FROM brand_diagnoses WHERE user_id = $1`,
    [userId],
  );
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO brand_diagnoses (user_id, version, dimensions, built_from_count)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, (prev?.version ?? 0) + 1, JSON.stringify(parsed), memoryCount],
  );
  await query(
    `UPDATE users SET strategist_stage = 'diagnosed'
     WHERE id = $1 AND strategist_stage IN ('new','connected')`,
    [userId],
  );

  // A fresh corpus is the moment to learn their voice — don't wait for the
  // nightly sweep, or /draft and reply drafting run voiceless all day one.
  if (!profile && memoryCount >= VOICE_MIN_MEMORIES) {
    await buildVoiceProfile(userId).catch((err) => console.error("post-diagnosis voice build failed", err));
  }

  // Do NOT dump the analysis. Open the paced session: one sharp observation +
  // one question. The diagnosis is revealed conversationally from here.
  if (opts.deliver && inserted) {
    await openSession(userId, inserted.id, parsed);
  }
  return parsed;
}

/**
 * Buttons per unsaid pattern: spin it into post angles, or — the deeper move —
 * synthesize the scattered fragments into the piece that was never written.
 */
export function unsaidPatternKeyboard(
  diagnosisId: string,
  patterns: Array<{ idea: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  patterns.slice(0, 3).forEach((p, i) => {
    kb.text(`💡 ${p.idea.slice(0, 32)}${p.idea.length > 32 ? "…" : ""}`, `dxang:${diagnosisId}:${i}`)
      .text("🧵 write it", `dxsyn:${diagnosisId}:${i}`)
      .row();
  });
  return kb;
}

/**
 * Split the diagnosis into a few readable Telegram messages (session-style).
 * Plain text only — these are sent without parse_mode, so markdown would show
 * as literal asterisks. Structure comes from the emoji headers, blank lines,
 * and bullets instead.
 */
export function formatDiagnosis(d: Diagnosis): string[] {
  const f = d.intellectual_fingerprint;
  const o = d.outside_in_gap;
  const parts: string[] = [];
  parts.push(d.headline);
  parts.push(
    `🧠 ${f.read}` +
      (f.owned_positions.length ? `\n\nGenuinely yours:\n${f.owned_positions.map((p) => `• ${p}`).join("\n")}` : "") +
      (f.latent_beliefs.length ? `\n\nBelieved but never said outright:\n${f.latent_beliefs.map((p) => `• ${p}`).join("\n")}` : ""),
  );
  parts.push(`🗣 ${d.voice_signature.read}${d.voice_signature.drift ? `\n\n• Drift: ${d.voice_signature.drift}` : ""}`);
  parts.push(
    `🌍 ${o.read}` +
      (o.missed_swings.length ? `\n\nSwings you didn't take:\n${o.missed_swings.map((s) => `• ${s}`).join("\n")}` : ""),
  );
  if (d.consistency_audit.length) {
    parts.push(
      `⚖️ Contradictions worth mining:\n\n${d.consistency_audit.map((c) => `• ${c.tension}\n  → ${c.why_interesting}`).join("\n\n")}`,
    );
  }
  if (d.unsaid_patterns.length) {
    parts.push(
      `💎 The unsaid. Your highest-value territory:\n\n${d.unsaid_patterns.map((u) => `• ${u.idea}\n  (${u.evidence})`).join("\n\n")}`,
    );
  }
  return parts;
}

export async function currentDiagnosis(
  userId: string,
): Promise<{ id: string; dimensions: Diagnosis; created_at: string } | null> {
  const row = await queryOne<{ id: string; dimensions: Diagnosis; created_at: string }>(
    `SELECT id, dimensions, created_at FROM brand_diagnoses WHERE user_id = $1 ORDER BY version DESC LIMIT 1`,
    [userId],
  );
  return row ?? null;
}

export async function diagnosisById(userId: string, id: string): Promise<Diagnosis | null> {
  const row = await queryOne<{ dimensions: Diagnosis }>(
    `SELECT dimensions FROM brand_diagnoses WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return row?.dimensions ?? null;
}
