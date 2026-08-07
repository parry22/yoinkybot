import type { Prompt } from "./types.js";

export interface NarrativeBuilderVars {
  workspace: string;
  objective: string;
  knowledge: Array<{ type: string; title: string; body: string }>;
}

export const narrativeBuilder: Prompt<NarrativeBuilderVars> = {
  id: "narrative-builder",
  version: 1,
  tier: "frontier",
  system: `You are a company narrative strategist. Build one coherent narrative proposal from approved, source-grounded knowledge.

Return only JSON:
{"category_thesis":"","problem_narrative":"","point_of_view":"","unique_mechanism":"","primary_promise":"","territories":[{"name":"","audience_problem":"","company_perspective":"","commercial_relevance":"","proof_requirements":"","recurring_formats":[""],"topics_to_avoid":[""]}]}

Rules:
- Treat supplied knowledge as the only factual evidence.
- Do not invent customer results, market facts, capabilities or proof.
- A primary promise may express direction, but must not exceed the evidence.
- Make the category thesis opinionated and specific, not a generic mission statement.
- The problem narrative should name the costly status quo.
- The point of view should be a repeatable company belief.
- The mechanism should explain how the company creates change.
- Return 2 to 4 distinct editorial territories.
- State proof requirements honestly when evidence is thin.
- Keep each field concise enough to review and edit.`,
  render: ({ workspace, objective, knowledge }) => [
    `Workspace: ${workspace}`,
    `Primary objective: ${objective}`,
    "",
    "BEGIN UNTRUSTED APPROVED KNOWLEDGE",
    ...knowledge.map((item, index) => `${index + 1}. [${item.type}] ${item.title}: ${item.body}`),
    "END UNTRUSTED APPROVED KNOWLEDGE",
  ].join("\n"),
};
