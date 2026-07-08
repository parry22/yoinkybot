import { describe, expect, it } from "vitest";
import { fuseRrf } from "./search.js";

const item = (id: string) => ({ id });

describe("fuseRrf", () => {
  it("ranks items appearing in both lists above single-list items", () => {
    const fused = fuseRrf([
      [item("a"), item("b"), item("c")],
      [item("b"), item("d")],
    ]);
    expect(fused[0]!.id).toBe("b");
  });

  it("preserves rank order within a single list", () => {
    const fused = fuseRrf([[item("x"), item("y"), item("z")]]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y", "z"]);
  });

  it("dedupes shared items", () => {
    const fused = fuseRrf([[item("a")], [item("a")]]);
    expect(fused).toHaveLength(1);
  });
});
