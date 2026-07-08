import { describe, expect, it } from "vitest";
import { splitTerritory, relativePerformance, parsePeersCommand } from "./peers.js";

describe("splitTerritory", () => {
  // Toy 2-d embeddings: close vectors = same territory.
  const v = (x: number, y: number) => [x, y];

  it("produces the three-way split with overlap percentage", () => {
    const userThemes = ["distribution strategy", "founder hiring"];
    const peerThemes = ["distribution playbooks", "ai coding tools"];
    const userVecs = [v(1, 0), v(0, 1)];
    const peerVecs = [v(0.98, 0.05), v(-1, 0.2)]; // first ≈ user's first; second far from both
    const s = splitTerritory(userThemes, peerThemes, userVecs, peerVecs, 0.35);
    expect(s.shared).toEqual(["distribution strategy"]);
    expect(s.userOnly).toEqual(["founder hiring"]);
    expect(s.peerOnly).toEqual(["ai coding tools"]);
    expect(s.overlapPct).toBe(50);
  });

  it("full overlap and zero overlap edges", () => {
    const same = splitTerritory(["a"], ["a2"], [v(1, 0)], [v(1, 0.01)], 0.35);
    expect(same.userOnly).toEqual([]);
    expect(same.overlapPct).toBe(100);

    const none = splitTerritory(["a"], ["b"], [v(1, 0)], [v(0, 1)], 0.35);
    expect(none.shared).toEqual([]);
    expect(none.peerOnly).toEqual(["b"]);
    expect(none.overlapPct).toBe(0);
  });

  it("empty user territory yields 0% without dividing by zero", () => {
    const s = splitTerritory([], ["x"], [], [v(1, 0)], 0.35);
    expect(s.overlapPct).toBe(0);
    expect(s.peerOnly).toEqual(["x"]);
  });
});

describe("relativePerformance", () => {
  it("computes period-vs-own-baseline ratio", () => {
    const r = relativePerformance([10, 10, 12, 8, 10], [15, 13]);
    expect(r.baseline).toBe(10);
    expect(r.periodMedian).toBe(14);
    expect(r.ratio).toBe(1.4);
  });

  it("null ratio when either side is missing — never a fake number", () => {
    expect(relativePerformance([], [10]).ratio).toBeNull();
    expect(relativePerformance([10, 12], []).ratio).toBeNull();
    expect(relativePerformance([0, 0, 0], [5]).ratio).toBeNull(); // zero baseline
  });
});

describe("parsePeersCommand", () => {
  it("bare → list", () => {
    expect(parsePeersCommand("")).toEqual({ kind: "list" });
  });

  it("add with note, platform, and defaults", () => {
    expect(parsePeersCommand("add @lennysan writes for the same founder audience")).toEqual({
      kind: "add",
      platform: "x",
      handle: "lennysan",
      note: "writes for the same founder audience",
    });
    expect(parsePeersCommand("add linkedin some-slug")).toEqual({
      kind: "add",
      platform: "linkedin",
      handle: "some-slug",
      note: null,
    });
  });

  it("remove", () => {
    expect(parsePeersCommand("remove @lennysan")).toEqual({ kind: "remove", handle: "lennysan" });
  });

  it("garbage → null (usage message)", () => {
    expect(parsePeersCommand("track everyone in my niche")).toBeNull();
  });
});
