import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { draftPostV2 } from "../prompts/draft.v2.js";
import { draftEvidence, memoryProvenance, EMPTY_EVIDENCE } from "./evidence.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile, profileSummaryForPrompt } from "../strategist/profile.js";
import { enforceStyle } from "../prompts/style.js";
import { embedOne } from "../llm/embeddings.js";
import { query } from "../db/pool.js";

/**
 * Cultural grounding: the freshest fleet trends nearest the draft request, so
 * the writer knows what's live on X around this topic RIGHT NOW. One cheap
 * embed + one pgvector query; best-effort (a drafting request must never fail
 * because the trends table is cold).
 */
async function nearbyTrends(userId: string, request: string, k = 4): Promise<Array<{ topic: string; summary: string }>> {
  try {
    const vec = await embedOne(request.slice(0, 1000), userId);
    const rows = await query<{ topic: string; summary: string | null }>(
      `SELECT topic, summary FROM trends
       WHERE embedding IS NOT NULL AND fetched_at > now() - interval '48 hours'
       ORDER BY embedding <=> $1::vector LIMIT $2`,
      [JSON.stringify(vec), k],
    );
    return rows.map((r) => ({ topic: r.topic, summary: r.summary ?? "" }));
  } catch {
    return [];
  }
}

const draftSchema = z.object({
  draft: z.string(),
  source_memory_ids: z.array(z.string()).default([]),
  media_suggestion: z.string().default(""),
  note: z.string().default(""),
});

export interface DraftResult {
  ok: boolean;
  draft: string;
  note: string;
  /** One concrete visual to pair with the post for reach, or "" if none fits. */
  mediaSuggestion: string;
  sources: Array<{ id: string; content: string; kind: string }>;
}

/**
 * A human-readable label for what the writer is doing right now. Optional: the
 * Telegram path ignores it, the web path streams it so the user sees the work
 * ("reading what's worked for you…") instead of a silent spinner.
 */
export type DraftStage =
  | "voice"
  | "memory"
  | "evidence"
  | "context"
  | "writing"
  | "polishing";

export interface DraftOpts {
  onStage?: (stage: DraftStage) => void;
}

/**
 * Memory-grounded drafting: retrieval is a mandatory pipeline step, and the
 * result always exposes which memories the draft was built from. No voice
 * profile → decline (never produce generic output).
 *
 * Since 2026-07-25 the writer is also EVIDENCE-grounded (drafting/evidence.ts):
 * it receives this user's own engagement baseline, the real text of posts that
 * beat it, which post shapes and intents measurably work for them, and whether
 * each retrieved memory came from something they actually published. Previously
 * it got style doctrine and memory fragments only, which is why it could not
 * reason about what blows up for this specific person.
 */
export async function generateDraft(
  userId: string,
  request: string,
  platform: "x" | "linkedin",
  opts: DraftOpts = {},
): Promise<DraftResult> {
  const stage = (s: DraftStage) => {
    try {
      opts.onStage?.(s);
    } catch {
      /* a progress listener must never break drafting */
    }
  };

  stage("voice");
  const profile = await currentVoiceProfile(userId);
  if (!profile) {
    return {
      ok: false,
      draft: "",
      note: "No voice profile yet — run /voice build once you have ~50 memories. Drafting without it would sound like everyone else.",
      mediaSuggestion: "",
      sources: [],
    };
  }

  stage("memory");
  const memories = await hybridSearch(userId, request, 12);
  if (memories.length === 0) {
    return { ok: false, draft: "", note: "No memories match this request — capture some thinking on it first.", mediaSuggestion: "", sources: [] };
  }

  stage("evidence");
  // All best-effort: a cold account with no engagement history still drafts, it
  // just falls back to universal doctrine instead of measured evidence.
  const [brandProfile, evidence, provenance] = await Promise.all([
    getProfile(userId).catch(() => null),
    draftEvidence(userId).catch(() => EMPTY_EVIDENCE),
    memoryProvenance(
      userId,
      memories.map((m) => m.capture_id).filter((id): id is string => !!id),
    ).catch(() => new Map()),
  ]);

  stage("context");
  const currentContext = await nearbyTrends(userId, request);

  stage("writing");
  const res = await llmCall({
    userId,
    eventType: "draft",
    tier: draftPostV2.tier,
    system: draftPostV2.system,
    user: draftPostV2.render({
      request,
      platform,
      memories: memories.map((m) => {
        const p = m.capture_id ? provenance.get(m.capture_id) : undefined;
        return {
          id: m.id,
          content: m.content,
          kind: m.kind,
          published: p?.published,
          engagement: p?.engagement ?? null,
          motive: p?.motive ?? null,
          sincerity: p?.sincerity ?? null,
        };
      }),
      voiceTraits: profile.traits,
      profileSummary: brandProfile ? profileSummaryForPrompt(brandProfile) : undefined,
      offLimits: brandProfile?.topics_off_limits ?? [],
      currentContext,
      evidence,
    }),
    json: true,
    maxTokens: 1500,
  });
  stage("polishing");
  const parsed = draftSchema.parse(res.parsed);
  const draft = enforceStyle(parsed.draft);
  const cited = new Set(parsed.source_memory_ids);
  const sources = memories
    .filter((m) => cited.has(m.id))
    .map((m) => ({ id: m.id, content: m.content, kind: m.kind }));

  return {
    ok: draft.length > 0,
    draft,
    note: parsed.note,
    mediaSuggestion: parsed.media_suggestion,
    // If the model cited nothing explicitly, show everything it was given.
    sources: sources.length > 0 ? sources : memories.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
  };
}
