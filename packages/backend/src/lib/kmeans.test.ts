import { describe, expect, it } from "vitest";
import { kmeans, parseVector } from "./kmeans.js";

describe("kmeans", () => {
  it("separates two obvious blobs", () => {
    const blobA = [
      [0, 0],
      [0.1, 0.1],
      [0.2, 0],
    ];
    const blobB = [
      [10, 10],
      [10.1, 9.9],
      [9.9, 10.2],
    ];
    const { assignments } = kmeans([...blobA, ...blobB], 2);
    const a = new Set(assignments.slice(0, 3));
    const b = new Set(assignments.slice(3));
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    expect([...a][0]).not.toBe([...b][0]);
  });

  it("is deterministic across runs", () => {
    const vs = Array.from({ length: 30 }, (_, i) => [i % 7, (i * 13) % 5]);
    expect(kmeans(vs, 3).assignments).toEqual(kmeans(vs, 3).assignments);
  });

  it("clamps k to n and handles empty input", () => {
    expect(kmeans([], 3).assignments).toEqual([]);
    expect(kmeans([[1, 2]], 5).assignments).toEqual([0]);
  });
});

describe("parseVector", () => {
  it("round-trips pgvector text format", () => {
    expect(parseVector("[0.5,-1.25,3]")).toEqual([0.5, -1.25, 3]);
  });
});
