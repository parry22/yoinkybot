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
import { activePositions } from "../memory/positions.js";
import { researchTopic, type TopicResearch } from "../trends/research.js";

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

/**
 * When a voice profile hasn't been built yet. Drafting used to REFUSE here
 * ("run /voice build once you have ~50 memories"), on the reasoning that a draft
 * without measured voice traits would sound like everyone else.
 *
 * That reasoning was right about the risk and wrong about the remedy. Refusing is
 * how a brand-new user's first request — the one that decides whether they come
 * back — got answered with a maintenance instruction. And the codebase already
 * disagreed with itself: draftFromAngle (drafting/angle-draft.ts) has always
 * drafted without a profile using exactly this fallback. So the two paths now
 * behave the same way, and the honest caveat rides out on the draft's `note`
 * instead of replacing the draft.
 */
const NO_VOICE_TRAITS = {
  note:
    "No voice profile built yet. Write in a clear, natural first-person voice drawn from the " +
    "material below — their own words, sentence rhythm and vocabulary. Avoid generic AI phrasing, " +
    "avoid inventing opinions they have not expressed.",
};

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
  | "research"
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
  const voiceTraits = profile?.traits ?? NO_VOICE_TRAITS;

  stage("memory");
  const memories = await hybridSearch(userId, request, 12);

  // NOTHING IN MEMORY IS NOT A DEAD END. It used to be: an empty retrieval
  // returned "capture some thinking on it first", which is the answer a user got
  // for the most natural request there is — "write me a post about <thing in the
  // news>". Nothing they'd said was about it yet, by definition.
  //
  // So a cold retrieval now triggers live research (trends/research.ts: X search
  // + cached trends + news) and the draft is grounded in THAT plus their stated
  // positions and profile. The one remaining refusal is when research also comes
  // back empty AND there are no positions to reason from — at that point there is
  // genuinely no material, and saying so is honest rather than evasive.
  let research: TopicResearch | null = null;
  let positions: string[] = [];
  if (memories.length === 0) {
    stage("research");
    [research, positions] = await Promise.all([
      researchTopic(userId, request, { maxPosts: 6, maxHeadlines: 4 }).catch(() => null),
      activePositions(userId)
        .then((ps) => ps.map((p) => p.statement))
        .catch(() => []),
    ]);
    const foundSomething = Boolean(research && (research.posts.length > 0 || research.headlines.length > 0));
    if (!foundSomething && positions.length === 0) {
      return {
        ok: false,
        draft: "",
        note:
          "I've got nothing to build this on — you haven't said anything about it, and there's no live " +
          "conversation on it I can find either. Tell me what you actually think and I'll write from that.",
        mediaSuggestion: "",
        sources: [],
      };
    }
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
  // Already-researched trends beat a second cached lookup for the same topic.
  const currentContext =
    research && research.headlines.length > 0
      ? research.headlines.map((h) => ({ topic: h.topic, summary: h.summary }))
      : await nearbyTrends(userId, request);

  // Grounding the model writes from: retrieved memories normally, and when there
  // were none, the researched conversation plus their stated positions. Both
  // shapes are the same `memories` array, labelled by `kind` so the prompt can
  // tell a real prior thought from a live tweet it should react to.
  const grounding =
    memories.length > 0
      ? memories.map((m) => {
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
        })
      : [
          ...positions.map((statement, i) => ({
            id: `position:${i}`,
            content: statement,
            kind: "position",
          })),
          ...(research?.posts ?? []).map((p, i) => ({
            id: `live:${i}`,
            content: `@${p.handle} on X right now (${p.likes} likes): ${p.text}`,
            kind: "live_conversation",
          })),
        ];

  stage("writing");
  const res = await llmCall({
    userId,
    eventType: "draft",
    tier: draftPostV2.tier,
    system: draftPostV2.system,
    user: draftPostV2.render({
      request,
      platform,
      memories: grounding,
      voiceTraits,
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
  // Only real memory rows are citable sources — the synthetic position:/live: ids
  // used for grounding are not persistable and must not reach `drafts.source_memory_ids`.
  const cited = new Set(parsed.source_memory_ids);
  const sources = memories
    .filter((m) => cited.has(m.id))
    .map((m) => ({ id: m.id, content: m.content, kind: m.kind }));
  const allMemories = memories.map((m) => ({ id: m.id, content: m.content, kind: m.kind }));

  // When the draft came from research rather than memory, say so — the user should
  // know it was built on the live conversation, not on something they'd told us.
  const provenanceNote =
    memories.length === 0 && research
      ? research.posts.length > 0
        ? `Built from what's live on X about this right now (${research.posts.length} posts) plus your stated positions — you hadn't said anything about it yet.`
        : `Built from your stated positions and what's in the news — you hadn't said anything about this yet.`
      : "";
  const voiceNote = profile
    ? ""
    : "Heads up: no voice profile built yet, so this is written from your own material rather than a measured voice model. It'll get sharper as I read more of you.";

  return {
    ok: draft.length > 0,
    draft,
    note: [parsed.note, provenanceNote, voiceNote].filter(Boolean).join(" "),
    mediaSuggestion: parsed.media_suggestion,
    // If the model cited nothing explicitly, show everything it was given.
    sources: sources.length > 0 ? sources : allMemories,
  };
}
