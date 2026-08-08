import type { Prompt } from "./types.js";

export interface BriefDraftVars {
  workspace: string;
  narrative: string;
  expert: string;
  voice: string;
  audience: string;
  approvedClaims: string[];
  proof: string[];
  channelRules: string;
  writingRules: string;
  performanceEvidence: string[];
  marketContext: string[];
  objective: string;
  beliefShift: string;
  channel: "x" | "linkedin";
  format: string;
  cta: string;
  sources: Array<{ type: string; body: string }>;
}

export const briefDraftPrompt: Prompt<BriefDraftVars> = {
  id: "brief-draft",
  version: 1,
  tier: "frontier",
  system: `You are a founder ghostwriter drafting from an approved company content brief.
Return only JSON: {"title":"","content":""}

Rules:
- Use only facts and evidence in the supplied sources. Never invent proof, customer results or personal experience.
- Write in the named expert's voice. Do not blend multiple experts.
- Keep the active narrative as strategic direction, not copy to repeat verbatim.
- Make the opening specific and useful. Avoid generic scene-setting.
- If evidence is qualified, preserve the qualification.
- The CTA must feel proportionate to the post.
- Follow the PLATFORM WRITING RULES block in the user message exactly.`,
  render: (vars) => [
    `PLATFORM WRITING RULES\n${vars.writingRules}\n`,
    `Workspace: ${vars.workspace}`,
    `Active narrative: ${vars.narrative}`,
    `Expert: ${vars.expert}`,
    `Expert voice: ${vars.voice}`,
    `Target audience: ${vars.audience}`,
    `Approved claims: ${vars.approvedClaims.join(" | ")}`,
    `Approved proof: ${vars.proof.join(" | ")}`,
    `Channel rules: ${vars.channelRules}`,
    `Performance evidence: ${vars.performanceEvidence.join(" | ") || "No reliable performance signal yet"}`,
    `Current market context: ${vars.marketContext.join(" | ") || "No approved market signal supplied"}`,
    `Brief objective: ${vars.objective}`,
    `Desired belief shift: ${vars.beliefShift}`,
    `Channel: ${vars.channel}`,
    `Format: ${vars.format}`,
    `CTA: ${vars.cta}`,
    "BEGIN UNTRUSTED APPROVED SOURCE MATERIAL",
    ...vars.sources.map((source, index) => `${index + 1}. [${source.type}] ${source.body}`),
    "END UNTRUSTED APPROVED SOURCE MATERIAL",
  ].join("\n"),
};
