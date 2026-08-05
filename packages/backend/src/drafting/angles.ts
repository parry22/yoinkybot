/**
 * Angles on demand, inside a chat turn.
 *
 * `jobs/offer-angles.ts` already generates three angles, but it is a PROACTIVE
 * path: it picks its own moment from the database, writes surfacing + angle rows,
 * and delivers through Telegram with an inline keyboard. None of that fits "give
 * me some angles on this topic" typed into Compose, which needs angles on an
 * arbitrary subject, returned as text, right now.
 *
 * So this shares the prompt (generate-angles.v1) and nothing else. The angles are
 * grounded in live research when there is any, and in the user's own positions
 * either way, so they are angles THIS person could credibly take rather than
 * generic takes on the topic.
 */
import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { generateAngles } from "../prompts/generate-angles.v1.js";
import { activePositions } from "../memory/positions.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { researchTopic, renderResearch, type TopicResearch } from "../trends/research.js";

const anglesSchema = z.object({
  angles: z
    .array(
      z.object({
        label: z.string().catch(""),
        angle: z.string().catch(""),
        hook: z.string().catch(""),
        why_it_lands: z.string().default(""),
      }),
    )
    .catch([]),
});

export interface TopicAngle {
  label: string;
  angle: string;
  hook: string;
  whyItLands: string;
}

export interface TopicAnglesResult {
  topic: string;
  angles: TopicAngle[];
  /** The research the angles were built on, so the caller can say where they came from. */
  research: TopicResearch | null;
}

/**
 * Two to three angles on `topic`. `research` is optional - pass one already
 * fetched (so a turn that just researched the topic doesn't pay for it twice),
 * or let this fetch its own.
 */
export async function anglesForTopic(
  userId: string,
  topic: string,
  research?: TopicResearch,
): Promise<TopicAnglesResult> {
  const found = research ?? (await researchTopic(userId, topic).catch(() => null));
  const [positions, profile] = await Promise.all([
    activePositions(userId).catch(() => []),
    currentVoiceProfile(userId).catch(() => null),
  ]);

  // The subject is the research when there is any, and the bare topic when there
  // isn't - angles on a topic with no live conversation are still worth having.
  const subject = found && (found.posts.length > 0 || found.headlines.length > 0)
    ? `${topic}\n\n${renderResearch(found)}`
    : topic;

  const res = await llmCall({
    userId,
    eventType: "angles",
    tier: generateAngles.tier,
    system: generateAngles.system,
    user: generateAngles.render({
      subject,
      subjectKind: "trend",
      title: topic,
      url: found?.headlines[0]?.url ?? "",
      positions: positions.map((p) => p.statement),
      voiceTraits: profile?.traits,
    }),
    json: true,
    maxTokens: 1024,
  });

  const parsed = anglesSchema.parse(res.parsed);
  const angles = parsed.angles
    .filter((a) => a.hook.trim() && a.angle.trim())
    .slice(0, 3)
    .map((a) => ({
      label: a.label.trim() || "Angle",
      angle: a.angle.trim(),
      hook: a.hook.trim(),
      whyItLands: a.why_it_lands.trim(),
    }));

  return { topic, angles, research: found };
}

/** The angles as a chat message - numbered, so "write #2" is an obvious next move. */
export function formatAngles(result: TopicAnglesResult): string {
  if (result.angles.length === 0) {
    return `couldn't find an angle on "${result.topic}" worth taking. tell me what you actually think about it and i'll build from that instead.`;
  }
  const sourced = result.research?.posts.length
    ? `here's what's live on "${result.topic}" and ${result.angles.length} ways you could take it:`
    : `${result.angles.length} ways you could take "${result.topic}":`;
  const body = result.angles
    .map((a, i) => `${i + 1}) ${a.label} - ${a.angle}\n   hook: ${a.hook}`)
    .join("\n\n");
  return `${sourced}\n\n${body}\n\nsay "write #1" (or paste your own spin) and i'll draft it.`;
}
