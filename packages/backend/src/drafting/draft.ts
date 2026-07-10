import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { draftPost } from "../prompts/draft.v1.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile, profileSummaryForPrompt } from "../strategist/profile.js";
import { enforceStyle } from "../prompts/style.js";

const draftSchema = z.object({
  draft: z.string(),
  source_memory_ids: z.array(z.string()).default([]),
  note: z.string().default(""),
});

export interface DraftResult {
  ok: boolean;
  draft: string;
  note: string;
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
      sources: [],
    };
  }

  const memories = await hybridSearch(userId, request, 12);
  if (memories.length === 0) {
    return { ok: false, draft: "", note: "No memories match this request — capture some thinking on it first.", sources: [] };
  }

  const brandProfile = await getProfile(userId).catch(() => null);

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
    // If the model cited nothing explicitly, show everything it was given.
    sources: sources.length > 0 ? sources : memories.map((m) => ({ id: m.id, content: m.content, kind: m.kind })),
  };
}
