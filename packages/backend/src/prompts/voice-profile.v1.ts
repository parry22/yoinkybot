import type { Prompt } from "./types.js";

export interface VoiceProfileVars {
  samples: Array<{ content: string; source: string }>;
}

export const voiceProfile: Prompt<VoiceProfileVars> = {
  id: "voice-profile",
  version: 1,
  tier: "frontier",
  system: `You build a voice profile from a person's raw thinking (voice notes, notes) and
published writing. The profile will steer drafting so output sounds like THEM, not like AI.

Analyze and return:
- tone: 3-5 adjectives with a sentence of evidence each
- sentence_rhythm: typical length, fragment usage, punctuation habits
- vocabulary: words/phrases they actually reuse; words they would never use
- structures: how they open, build, and land a point (with a real example from the samples)
- stances: recurring attitudes (contrarian about X, earnest about Y)
- tics: distinctive habits (rhetorical questions, lowercase, specific emoji, Hinglish switches)
- anti_patterns: generic-AI patterns that would immediately feel wrong for this person

Ground every trait in the samples. If the samples are too thin or too uniform to support a
trait, omit it rather than invent it.

Respond with ONLY valid JSON:
{"tone":[{"adjective":"...","evidence":"..."}],"sentence_rhythm":"...","vocabulary":{"uses":["..."],"avoids":["..."]},
 "structures":"...","stances":["..."],"tics":["..."],"anti_patterns":["..."]}`,
  render: ({ samples }) =>
    `Writing/thinking samples:\n\n${samples
      .map((s, i) => `--- sample ${i + 1} (${s.source}) ---\n${s.content}`)
      .join("\n\n")}`,
};
