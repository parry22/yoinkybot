import { z } from "zod";
import { query, queryOne, toVector } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { embedOne } from "../llm/embeddings.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { createCapture } from "../capture/service.js";
import { repurpose as repurposePrompt, type RepurposeVars } from "../prompts/repurpose.v1.js";
import { enforceStyle } from "../prompts/style.js";
import type { Platform } from "../lib/types.js";

/**
 * Repurposing = TRANSFORMATION of finished material, never fresh generation.
 * /draft starts from a topic; angle-offering starts from an undeveloped memory;
 * this starts from something that already has a shape and re-forms it. The
 * fidelity check below is what keeps it that way.
 */

export type RepurposeMode = "cross_platform" | "cross_format" | "synthesis";
export type SourceType = "published_post" | "draft" | "memory_cluster" | "pasted_content";
export type { Platform };

/** Output drifting past this cosine distance from its source triggers one regeneration. */
const FIDELITY_MAX_DISTANCE = 0.4;
/** Synthesis needs at least this many fragments to be a real piece, not padding. */
const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTER_SIZE = 12;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

export function lengthStats(lengths: number[]): { median: number; p25: number; p75: number } | null {
  if (lengths.length < 3) return null;
  const s = [...lengths].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
  return { median: at(0.5), p25: at(0.25), p75: at(0.75) };
}

export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function fidelityOk(distance: number): boolean {
  return distance <= FIDELITY_MAX_DISTANCE;
}

export interface ParsedRepurposeCommand {
  mode: RepurposeMode;
  target: Platform;
  direction?: "compress" | "expand";
  text: string;
}

/**
 * Parse "/repurpose <form> <content>". Forms: "x"/"linkedin" (cross-platform),
 * "compress"/"expand" (cross-format, defaults to X), "synthesis <theme>"
 * (long-form, defaults to LinkedIn). Null → show usage.
 */
export function parseRepurposeCommand(arg: string): ParsedRepurposeCommand | null {
  const m = arg.trim().match(/^(x|twitter|linkedin|compress|expand|synthesis)\s+([\s\S]+)$/i);
  if (!m?.[1] || !m[2]?.trim()) return null;
  const form = m[1].toLowerCase();
  const text = m[2].trim();
  if (form === "linkedin") return { mode: "cross_platform", target: "linkedin", text };
  if (form === "x" || form === "twitter") return { mode: "cross_platform", target: "x", text };
  if (form === "compress" || form === "expand") {
    return { mode: "cross_format", target: "x", direction: form, text };
  }
  return { mode: "synthesis", target: "linkedin", text };
}

// ── Computation layer (code, not model) ──────────────────────────────────────

async function targetContext(userId: string, platform: Platform): Promise<RepurposeVars["targetContext"]> {
  const source = platform === "x" ? "x_import" : "linkedin_import";
  const rows = await query<{ len: number }>(
    `SELECT length(raw_text) AS len FROM captures
     WHERE user_id = $1 AND source = $2 AND raw_text IS NOT NULL
       AND (metadata->>'published')::boolean IS TRUE`,
    [userId, source],
  );
  const stats = lengthStats(rows.map((r) => r.len));
  return {
    hasHistory: rows.length >= 5 && stats !== null,
    postCount: rows.length,
    lenMedian: stats?.median ?? null,
    lenP25: stats?.p25 ?? null,
    lenP75: stats?.p75 ?? null,
  };
}

interface ClusterFragment {
  id: string;
  content: string;
  created_at: string;
}

/**
 * Assemble the synthesis cluster BEFORE generation: semantic neighbors of the
 * theme plus anything linked to them by extends/echoes, chronological. The
 * model gets the argument's raw material; deciding what belongs in it is not
 * the model's job.
 */
async function synthesisCluster(userId: string, theme: string): Promise<{ fragments: ClusterFragment[]; evolution: string[] }> {
  const vec = toVector(await embedOne(theme, userId));

  const semantic = await query<ClusterFragment & { distance: number }>(
    `SELECT id, content, created_at::text, (embedding <=> $2::vector) AS distance
     FROM memories
     WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
       AND (embedding <=> $2::vector) < 0.45
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [userId, vec, MAX_CLUSTER_SIZE],
  );

  // One hop of extends/echoes links around the semantic seeds — fragments that
  // belong to the argument even when their wording sits further from the theme.
  const linked = semantic.length
    ? await query<ClusterFragment>(
        `SELECT DISTINCT m2.id, m2.content, m2.created_at::text
         FROM memory_links l
         JOIN memories m2 ON m2.id = CASE WHEN l.memory_a = ANY($2::uuid[]) THEN l.memory_b ELSE l.memory_a END
         WHERE (l.memory_a = ANY($2::uuid[]) OR l.memory_b = ANY($2::uuid[]))
           AND l.link_type IN ('extends','echoes')
           AND m2.user_id = $1 AND m2.status = 'active'`,
        [userId, semantic.map((s) => s.id)],
      )
    : [];

  const byId = new Map<string, ClusterFragment>();
  for (const f of [...semantic, ...linked]) byId.set(f.id, { id: f.id, content: f.content, created_at: f.created_at });
  const fragments = [...byId.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_CLUSTER_SIZE);

  // Real belief evolution near this theme — handed to the model so it never
  // silently smooths over a change of mind.
  const evolution = await query<{ old_statement: string; new_statement: string }>(
    `SELECT old_p.statement AS old_statement, new_p.statement AS new_statement
     FROM positions old_p
     JOIN positions new_p ON new_p.id = old_p.superseded_by
     WHERE old_p.user_id = $1 AND old_p.status = 'evolved'
       AND old_p.embedding IS NOT NULL AND (old_p.embedding <=> $2::vector) < 0.5
     LIMIT 3`,
    [userId, vec],
  );

  return {
    fragments,
    evolution: evolution.map((e) => `they used to say "${e.old_statement}", now they say "${e.new_statement}"`),
  };
}

// ── The transformation ───────────────────────────────────────────────────────

const outputSchema = z.object({ output: z.string().default(""), notes: z.string().default("") });

export interface RepurposeRequest {
  mode: RepurposeMode;
  target: Platform;
  direction?: "compress" | "expand";
  sourceType: SourceType;
  /** Pasted/draft/published text (non-synthesis modes). */
  sourceText?: string;
  /** Synthesis theme (unsaid-pattern idea, or the user's own words). */
  theme?: string;
  /** Known lineage ids (draft id, capture-derived memory ids). */
  sourceIds?: string[];
  /** Staged attachments copied from the source post. */
  mediaIds?: string[];
}

export interface RepurposeResult {
  ok: boolean;
  id?: string;
  output: string;
  notes: string;
}

export async function repurposedForSchedule(
  userId: string,
  id: string,
): Promise<{ platform: Platform; content: string; mediaIds: string[] } | null> {
  const row = await queryOne<{ target_platform: Platform; output_text: string; media_ids: string[] | null }>(
    `SELECT target_platform, output_text, media_ids FROM repurposed_content
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return row
    ? { platform: row.target_platform, content: row.output_text, mediaIds: row.media_ids ?? [] }
    : null;
}

export async function repurposeContent(userId: string, req: RepurposeRequest): Promise<RepurposeResult> {
  let sources: Array<{ content: string; created_at?: string }>;
  let sourceIds = req.sourceIds ?? [];
  let evolutionNotes: string[] = [];

  if (req.mode === "synthesis") {
    const { fragments, evolution } = await synthesisCluster(userId, req.theme ?? "");
    if (fragments.length < MIN_CLUSTER_SIZE) {
      return {
        ok: false,
        output: "",
        notes: `I only found ${fragments.length} fragment${fragments.length === 1 ? "" : "s"} circling that idea — not enough to assemble a real piece. Keep thinking out loud about it and I'll flag when there's enough to write.`,
      };
    }
    sources = fragments.map((f) => ({ content: f.content, created_at: f.created_at }));
    sourceIds = fragments.map((f) => f.id);
    evolutionNotes = evolution;
  } else {
    if (!req.sourceText?.trim()) return { ok: false, output: "", notes: "Nothing to repurpose — paste the content." };
    sources = [{ content: req.sourceText.trim() }];
  }

  const [ctx, profile] = await Promise.all([targetContext(userId, req.target), currentVoiceProfile(userId)]);

  const generate = async (extra?: string) => {
    const res = await llmCall({
      userId,
      eventType: "repurpose",
      tier: repurposePrompt.tier,
      system: repurposePrompt.system,
      user:
        repurposePrompt.render({
          mode: req.mode,
          direction: req.direction,
          targetPlatform: req.target,
          sources,
          targetContext: ctx,
          voiceTraits: profile?.traits,
          evolutionNotes,
          theme: req.theme,
        }) + (extra ? `\n\n${extra}` : ""),
      json: true,
      maxTokens: req.mode === "synthesis" ? 2200 : 900,
    });
    return outputSchema.parse(res.parsed);
  };

  let parsed = await generate();
  if (!parsed.output.trim()) {
    // Honest refusal (complete thought, thin cluster) — surface the reason, store nothing.
    return { ok: false, output: "", notes: parsed.notes || "This one doesn't transform well — it's complete as it stands." };
  }

  // Source fidelity: the output must stay anchored to what the source said.
  // One regeneration on drift; keep whichever run stayed closer.
  try {
    const sourceVec = await embedOne(sources.map((s) => s.content).join("\n"), userId);
    let distance = cosineDistance(await embedOne(parsed.output, userId), sourceVec);
    if (!fidelityOk(distance)) {
      console.warn(`repurpose fidelity drift (${distance.toFixed(2)}) — regenerating once`);
      const retry = await generate(
        "YOUR PREVIOUS ATTEMPT DRIFTED FROM THE SOURCE. Stay strictly on what the source material actually says — no new claims, no new framing. Transform, don't rewrite.",
      );
      if (retry.output.trim()) {
        const retryDistance = cosineDistance(await embedOne(retry.output, userId), sourceVec);
        if (retryDistance < distance) {
          parsed = retry;
          distance = retryDistance;
        }
      }
      if (!fidelityOk(distance)) {
        parsed.notes = [parsed.notes, "Heads up: this drifted further from your original than I'd like. Read it against the source before using it."]
          .filter(Boolean)
          .join(" ");
      }
    }
  } catch (err) {
    // Fidelity couldn't be verified (e.g. the embedding call failed). Don't ship
    // it as if it passed — say so, so the user reads it against their source.
    console.error("fidelity check failed; flagging as unverified", err);
    parsed.notes = [parsed.notes, "Heads up: I couldn't verify this stayed true to your original just now, so read it against the source before using it."]
      .filter(Boolean)
      .join(" ");
  }

  const output = enforceStyle(parsed.output);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO repurposed_content (user_id, source_type, source_ids, mode, target_platform, output_text, media_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, req.sourceType, sourceIds, req.mode, req.target, output, req.mediaIds ?? []],
  );
  return { ok: true, id: row?.id, output, notes: parsed.notes };
}

/** "Posted it" → mark used and log it as real published output (feeds voice + diagnosis). */
export async function recordRepurposeUse(userId: string, id: string, used: boolean): Promise<string> {
  const row = await queryOne<{ output_text: string; target_platform: Platform; used: boolean }>(
    `SELECT output_text, target_platform, used FROM repurposed_content WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!row) return "Can't find that one anymore.";
  if (!used) return "Noted, letting it sit.";
  if (row.used) return "Already logged that one.";
  await query(`UPDATE repurposed_content SET used = true, used_at = now() WHERE id = $1`, [id]);
  await createCapture({
    userId,
    source: row.target_platform === "linkedin" ? "linkedin_import" : "x_import",
    rawText: row.output_text,
    metadata: { published: true, repurposed_content_id: id },
  });
  return "Logged as posted. It'll feed your voice profile like anything else you publish.";
}
