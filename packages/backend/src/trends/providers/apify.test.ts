import { describe, expect, it } from "vitest";
import { parseXTrendItems, parseLinkedInTrendItems } from "./apify.js";

// Field shapes below are trimmed from live runs (2026-07-04) of
// kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest and
// harvestapi/linkedin-post-search — this locks in the real API shape so a
// silent actor-output change breaks a test instead of the trend pipeline.
describe("parseXTrendItems", () => {
  it("parses real tweet fields and ranks by engagement", () => {
    const items = [
      { id: "1", text: "low engagement take", likeCount: 10, retweetCount: 1 },
      { noResults: true },
      { id: "2", text: "Running a startup is about distribution.", likeCount: 319, retweetCount: 20, url: "https://x.com/a/status/2" },
    ];
    const trends = parseXTrendItems(items);
    expect(trends).toHaveLength(2);
    expect(trends[0]!.topic).toBe("Running a startup is about distribution.");
    expect(trends[0]!.platform).toBe("x");
    expect(trends[0]!.url).toBe("https://x.com/a/status/2");
  });

  it("drops items with no text or no id", () => {
    expect(parseXTrendItems([{ text: "no id here" }, { id: "3" }])).toEqual([]);
  });
});

describe("parseLinkedInTrendItems", () => {
  it("parses the 'content' field (not 'text') and ranks by likes+comments", () => {
    const items = [
      {
        id: "7479109801256456192",
        linkedinUrl: "https://www.linkedin.com/posts/a",
        content: "quiet post",
        engagement: { likes: 2, comments: 0 },
      },
      {
        id: "7474476748483727360",
        linkedinUrl: "https://www.linkedin.com/posts/b",
        content: "Seeking an angel investor for a startup",
        engagement: { likes: 13, comments: 5 },
      },
    ];
    const trends = parseLinkedInTrendItems(items);
    expect(trends).toHaveLength(2);
    expect(trends[0]!.topic).toBe("Seeking an angel investor for a startup");
    expect(trends[0]!.platform).toBe("linkedin");
  });
});
