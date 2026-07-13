import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES, REACH_PRINCIPLES } from "./style.js";

export interface GenerateAnglesVars {
  /** The thing to narrate: a moment excerpt or a matched trend. */
  subject: string;
  subjectKind: "moment" | "trend";
  title: string;
  url: string;
  positions: string[];
  /** Optional voice traits (JSON) to keep hooks sounding like the user. */
  voiceTraits?: unknown;
}

/**
 * Produces THREE distinct narrative angles for a moment/trend — angle only, no
 * full draft. The user picks one and drafting (existing draft.v1) writes it.
 */
export const generateAngles: Prompt<GenerateAnglesVars> = {
  id: "generate-angles",
  version: 1,
  tier: "frontier",
  system: `You are a sharp brand strategist for someone building a public voice (a16z "new media"
mindset: own your narrative, ship consistently, ride the moment). Given something they engaged
with — plus the views they already hold — propose THREE genuinely different ways they could tell
this as their own story.

Each angle must:
- take a real, distinct stance (e.g. one contrarian, one personal-story, one practical-breakdown) —
  not three rephrasings of the same point,
- be grounded in the person's actual positions; never invent facts or opinions they don't hold,
- give a concrete hook (the opening line/idea that makes someone stop scrolling).

Keep hooks in their voice if voice traits are provided. Do not write the full post.

The hook is the actual opening line of a post — it must obey these rules, not just gesture at them:
${CHAT_STYLE_RULES}
Additionally for hooks specifically: never open with a hook-label ("Contrarian take:") — the
label field is separate from the hook text; the hook itself must read as the first real sentence
of the post, landing cold with no framing.

${REACH_PRINCIPLES}

Respond with ONLY valid JSON:
{"angles":[{"label":"2-4 word name","angle":"one sentence: the take","hook":"the opening line","why_it_lands":"one sentence"}]}
Return exactly 3 angles.`,
  render: ({ subject, subjectKind, title, url, positions, voiceTraits }) =>
    `Subject (${subjectKind}): ${title}\nURL: ${url}\n\nContent:\n${subject}\n\n` +
    `Their existing positions:\n${positions.length ? positions.map((p) => `- ${p}`).join("\n") : "(few known yet — keep angles broad but on-topic)"}` +
    (voiceTraits ? `\n\nVoice traits:\n${JSON.stringify(voiceTraits)}` : ""),
};
