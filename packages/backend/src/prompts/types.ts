export interface Prompt<V> {
  id: string;
  version: number;
  /** Advisory effort tier → reasoning_effort in the gateway (cheap/none→low,
   *  frontier→high). "none" is for pure-formatting calls that need no deliberation. */
  tier: "none" | "cheap" | "frontier";
  system: string;
  render: (vars: V) => string;
}
