export interface Prompt<V> {
  id: string;
  version: number;
  tier: "cheap" | "frontier";
  system: string;
  render: (vars: V) => string;
}
