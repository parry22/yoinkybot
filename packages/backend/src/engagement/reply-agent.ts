import { z } from "zod";
import { config } from "../config.js";
import { type ToolLoopStep } from "../llm/tool-loop.js";
import { runAgentLoop } from "../agent-runtime/run-agent-loop.js";
import { hybridSearch } from "../memory/search.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { getProfile } from "../strategist/profile.js";
import { activePositions } from "../memory/positions.js";
import { pullTweetsByIds, searchTweets, type XTweet } from "../capture/imports/twitterapi-io.js";
import { replyDraftAgent } from "../prompts/reply-draft.v2.js";
import { replyToolSchema } from "./tools.js";
import { computeHeuristics } from "./heuristics.js";

/**
 * The agentic drafting step for one mention that already cleared the
 * deterministic reply-worthy bar (engagement/scoring.ts - untouched, by
 * design). The loop lets the model pull grounding before writing: memory,
 * voice, pillars, the full thread, and computed visibility facts.
 */

export interface ReplyAgentMention {
  id: string;
  externalId: string;
  authorHandle: string;
  content: string;
  url: string | null;
  postedAt: Date;
}

export interface ReplyAgentResult {
  intro: string;
  draft: string;
  citedMemoryIds: string[];
  distributionRationale: string;
  steps: ToolLoopStep[];
}

const outputSchema = z.object({
  intro: z.string().min(1),
  draft: z.string().min(1),
  cited_memory_ids: z.array(z.string()).catch([]),
  distribution_rationale: z.string().catch(""),
});

export async function draftReplyWithAgent(
  userId: string,
  mention: ReplyAgentMention,
  reasons: string[],
  relationship: { priorMentions: number; repliesSent: number },
): Promise<ReplyAgentResult> {
  const positions = await activePositions(userId);

  // The mention tweet's live stats are needed by two tools; fetch at most once.
  let tweetLookup: Promise<XTweet | undefined> | undefined;
  const liveTweet = () => {
    tweetLookup ??= pullTweetsByIds([mention.externalId])
      .then((ts) => ts[0])
      .catch(() => undefined);
    return tweetLookup;
  };

  const executors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    search_memory: async (args) => {
      const rows = await hybridSearch(userId, String(args.query ?? ""), 5);
      if (rows.length === 0) return "nothing in memory matches";
      return rows.map((m) => `- [${m.id}] (${m.kind}, ${m.created_at.slice(0, 10)}) ${m.content.slice(0, 280)}`).join("\n");
    },
    get_voice_profile: async () => {
      const profile = await currentVoiceProfile(userId);
      return profile?.traits ? JSON.stringify(profile.traits).slice(0, 900) : "no voice profile built yet - default to plain, blunt, no filler";
    },
    get_content_pillars: async () => {
      const profile = await getProfile(userId);
      if (!profile) return "no brand profile yet";
      const bits = [
        profile.niche ? `niche: ${profile.niche}` : "",
        profile.content_pillars.length ? `pillars: ${profile.content_pillars.join("; ")}` : "no pillars set",
        profile.topics_off_limits.length ? `OFF-LIMITS topics: ${profile.topics_off_limits.join("; ")}` : "",
      ].filter(Boolean);
      return bits.join("\n");
    },
    get_thread_context: async () => {
      const tweet = await liveTweet();
      const conversationId = tweet?.conversationId;
      if (!conversationId) return "couldn't resolve the thread - treat the mention as standalone";
      try {
        const thread = await searchTweets(`conversation_id:${conversationId} lang:en`, {
          queryType: "Latest",
          maxPages: 1,
        });
        if (thread.length === 0) return "thread lookup returned nothing - treat the mention as standalone";
        return thread
          .slice(0, 10)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((t) => `@${t.authorHandle}: ${t.text.slice(0, 240)}`)
          .join("\n");
      } catch (err) {
        return `thread lookup failed (${err instanceof Error ? err.message : "error"}) - treat the mention as standalone`;
      }
    },
    get_engagement_heuristics: async () => {
      const tweet = await liveTweet();
      const h = computeHeuristics({
        postedAtMs: mention.postedAt.getTime(),
        nowMs: Date.now(),
        replyCount: tweet?.replyCount ?? 0,
        likeCount: tweet?.likeCount ?? 0,
        retweetCount: tweet?.retweetCount ?? 0,
      });
      const caveat = tweet ? "" : " (live counts unavailable - reply/like counts read 0)";
      return JSON.stringify(h) + caveat;
    },
  };

  const { output, steps } = await runAgentLoop("reply", {
    userId,
    eventType: "reply_draft",
    tier: replyDraftAgent.tier,
    system: replyDraftAgent.system,
    renderUser: (notes) =>
      replyDraftAgent.render({
        mention: { authorHandle: mention.authorHandle, content: mention.content, url: mention.url },
        reasons,
        relationship,
        positions: positions.map((p) => p.statement),
        toolNotes: notes,
        toolCallsRemaining: Math.max(0, config.REPLY_AGENT_MAX_TOOL_CALLS - notes.length),
      }),
    toolSchema: replyToolSchema,
    executors,
    outputSchema,
    maxToolCalls: config.REPLY_AGENT_MAX_TOOL_CALLS,
    maxTokens: 600,
  });

  return {
    intro: output.intro,
    draft: output.draft,
    citedMemoryIds: output.cited_memory_ids,
    distributionRationale: output.distribution_rationale,
    steps,
  };
}
