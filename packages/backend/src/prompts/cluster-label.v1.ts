import type { Prompt } from "./types.js";

export interface ClusterLabelVars {
  clusters: Array<{ index: number; samples: string[] }>;
}

export const clusterLabel: Prompt<ClusterLabelVars> = {
  id: "cluster-label",
  version: 1,
  tier: "cheap",
  system: `You label thematic clusters of a person's thoughts for their memory map. Each
label is 2-4 words, specific to the actual content (not "Miscellaneous Thoughts" or
"Ideas & Insights"). Use the person's own vocabulary where it shows.

Respond with ONLY valid JSON: {"labels":[{"index":0,"label":"..."}]}`,
  render: ({ clusters }) =>
    clusters
      .map((c) => `Cluster ${c.index}:\n${c.samples.map((s) => `- ${s}`).join("\n")}`)
      .join("\n\n"),
};
