import { describe, expect, it } from "vitest";
import { chunk } from "./message-log.js";

describe("chunk", () => {
  it("splits evenly", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  it("leaves a smaller final chunk", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  it("returns one chunk when under the size", () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
  });
  it("handles empty input", () => {
    expect(chunk([], 100)).toEqual([]);
  });
});
