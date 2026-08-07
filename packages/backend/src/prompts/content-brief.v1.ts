import type { Prompt } from "./types.js";

export interface ContentBriefVars {
  objective: string;
  narrative: string;
  territories: string[];
  knowledge: Array<{ id: string; type: string; title: string; body: string }>;
  preferredKnowledgeIds?: string[];
  userPrompt?: string;
  audiences: Array<{ id: string; name: string; description: string | null }>;
  journeyGaps: Array<{ audience: string; stage: string; question: string }>;
  campaignNeeds: string[];
  performanceEvidence: string[];
  marketContext: string[];
  channel: "x" | "linkedin";
}

export const contentBriefPrompt: Prompt<ContentBriefVars> = {
  id: "content-brief",
  version: 1,
  tier: "frontier",
  system: `You are a B2B content strategist creating one grounded content brief.
Return only JSON:
{"objective":"","audience_id":"","buying_stage":"problem_aware","territory_name":"","desired_belief_shift":"","core_insight_id":"","supporting_claim_id":"","primary_proof_id":"","source_ids":[""],"format":"text_post","primary_emotion":"","reason_now":"","cta":""}

Rules:
- Use only supplied source IDs and facts.
- The core insight is required and must be source-grounded.
- Select one supplied audience, one approved supporting claim and one concrete proof object.
- Prefer preferred knowledge IDs when they are eligible for the required roles.
- If a user prompt is supplied, shape the objective and belief shift around it without inventing facts.
- Use proof only when a supplied proof object is concrete evidence.
- Do not turn an insight or opinion into proof.
- Make the belief shift specific: from an existing assumption to a new belief.
- Make the format native to the requested channel.
- For LinkedIn, favor professional utility, credible first-person experience and whitespace. Do not use engagement bait.
- The CTA should match the reader's stage and should not force an external link.
- Explain why the brief should exist now without inventing a trend.`,
  render: ({ objective, narrative, territories, knowledge, preferredKnowledgeIds, userPrompt, audiences, journeyGaps, campaignNeeds, performanceEvidence, marketContext, channel }) => [
    `Business objective: ${objective}`,
    `Active narrative: ${narrative}`,
    `Editorial territories: ${territories.join(" | ")}`,
    `Channel: ${channel}`,
    preferredKnowledgeIds?.length ? `Preferred knowledge IDs: ${preferredKnowledgeIds.join(", ")}` : "Preferred knowledge IDs: none",
    userPrompt?.trim() ? `User prompt: ${userPrompt.trim()}` : "User prompt: none",
    `Target audiences: ${audiences.map((item)=>`${item.id} ${item.name}: ${item.description??""}`).join(" | ")}`,
    `Open buyer questions: ${journeyGaps.map((item)=>`${item.audience} / ${item.stage}: ${item.question}`).join(" | ") || "None"}`,
    `Campaign needs: ${campaignNeeds.join(" | ") || "None"}`,
    `Performance evidence: ${performanceEvidence.join(" | ") || "None yet"}`,
    `Current market opportunities: ${marketContext.join(" | ") || "None supplied"}`,
    "BEGIN UNTRUSTED APPROVED SOURCE KNOWLEDGE",
    ...knowledge.map((item) => `${item.id} [${item.type}] ${item.title}: ${item.body}`),
    "END UNTRUSTED APPROVED SOURCE KNOWLEDGE",
  ].join("\n"),
};
