import { describe, expect, it } from "vitest";
import { parseXArchive, applyRecencyWindow, type ImportedPost } from "./x.js";
import { parseCsv, parseLinkedInShares } from "./linkedin.js";

describe("applyRecencyWindow", () => {
  const DAY = 86_400_000;
  const NOW = 1_800_000_000_000;
  const post = (daysAgo: number): ImportedPost => ({
    text: `post from ${daysAgo}d ago`,
    postedAt: new Date(NOW - daysAgo * DAY),
  });
  const opts = { days: 90, minPosts: 40, maxPosts: 120 };

  it("keeps only the window when it has enough posts", () => {
    const posts = [...Array.from({ length: 50 }, (_, i) => post(i)), ...Array.from({ length: 60 }, (_, i) => post(100 + i))];
    const out = applyRecencyWindow(posts, opts, NOW);
    expect(out).toHaveLength(50);
    expect(out.every((p) => p.postedAt.getTime() >= NOW - 90 * DAY)).toBe(true);
  });

  it("backfills a thin window from older history up to the quality floor", () => {
    const posts = [...Array.from({ length: 10 }, (_, i) => post(i)), ...Array.from({ length: 100 }, (_, i) => post(100 + i))];
    const out = applyRecencyWindow(posts, opts, NOW);
    expect(out).toHaveLength(40); // 10 recent + 30 most recent older
    expect(out[0]!.postedAt.getTime()).toBeGreaterThan(out[39]!.postedAt.getTime()); // newest first
  });

  it("caps a prolific window at maxPosts, keeping the newest", () => {
    const posts = Array.from({ length: 300 }, (_, i) => post(i * 0.25)); // 300 posts inside 75 days
    const out = applyRecencyWindow(posts, opts, NOW);
    expect(out).toHaveLength(120);
    expect(out[0]!.postedAt.getTime()).toBe(NOW);
  });

  it("returns everything for a tiny account", () => {
    expect(applyRecencyWindow([post(200), post(300)], opts, NOW)).toHaveLength(2);
  });
});

describe("parseXArchive", () => {
  const archive =
    "window.YTD.tweets.part0 = " +
    JSON.stringify([
      {
        tweet: {
          id_str: "111",
          full_text: "Building in public is mostly about surviving your own inconsistency &amp; showing up",
          created_at: "Mon Mar 10 09:00:00 +0000 2025",
        },
      },
      { tweet: { id_str: "222", full_text: "RT @someone: their idea not mine", created_at: "Mon Mar 10 09:05:00 +0000 2025" } },
      { tweet: { id_str: "333", full_text: "", created_at: "Mon Mar 10 09:06:00 +0000 2025" } },
    ]);

  it("parses the window.YTD prefix format and keeps original tweets", () => {
    const posts = parseXArchive(archive);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("inconsistency & showing up"); // entity decoded
    expect(posts[0]!.url).toBe("https://x.com/i/status/111");
    expect(posts[0]!.postedAt.getUTCFullYear()).toBe(2025);
  });

  it("accepts a bare JSON array too", () => {
    const posts = parseXArchive(JSON.stringify([{ tweet: { full_text: "hello world thoughts", id_str: "9" } }]));
    expect(posts).toHaveLength(1);
  });

  it("throws a helpful error on garbage", () => {
    expect(() => parseXArchive("not json at all")).toThrow(/tweets\.js/);
  });
});

describe("parseCsv", () => {
  it("handles quoted fields with commas, escaped quotes, and embedded newlines", () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi""\nnext line",');
    expect(rows[1]).toEqual(["x, y", 'he said "hi"\nnext line', ""]);
  });
});

describe("parseLinkedInShares", () => {
  const csv = [
    "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
    '2025-05-01 10:00:00,https://linkedin.com/feed/update/1,"Hiring is a memory problem, not a sourcing problem.",,,PUBLIC',
    "2025-05-02 11:00:00,https://linkedin.com/feed/update/2,,,,PUBLIC",
  ].join("\n");

  it("extracts commentary rows and skips empty shares", () => {
    const posts = parseLinkedInShares(csv);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("memory problem");
    expect(posts[0]!.url).toBe("https://linkedin.com/feed/update/1");
  });

  it("rejects a CSV without ShareCommentary", () => {
    expect(() => parseLinkedInShares("a,b\n1,2")).toThrow(/ShareCommentary/);
  });
});
