import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { draftPost } from "../prompts/draft.v1.js";
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
 * Memory-grounded drafting: retrieval is a mandatory pipeline step, and the
 * result always exposes which memories the draft was built from. No voice
 * profile → decline (never produce generic output).
 */
export async function generateDraft(
  userId: string,
  request: string,
  platform: "x" | "linkedin",
): Promise<DraftResult> {
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

  const memories = await hybridSearch(userId, request, 12);
  if (memories.length === 0) {
    return { ok: false, draft: "", note: "No memories match this request — capture some thinking on it first.", mediaSuggestion: "", sources: [] };
  }

  const [brandProfile, currentContext] = await Promise.all([
    getProfile(userId).catch(() => null),
    nearbyTrends(userId, request),
  ]);

  const res = await llmCall({
    userId,
    eventType: "draft",
    tier: draftPost.tier,
    system: draftPost.system,
    user: draftPost.render({
      request,
      platform,
      memories: memories.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
      voiceTraits: profile.traits,
      profileSummary: brandProfile ? profileSummaryForPrompt(brandProfile) : undefined,
      offLimits: brandProfile?.topics_off_limits ?? [],
      currentContext,
    }),
    json: true,
    maxTokens: 1500,
  });
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
