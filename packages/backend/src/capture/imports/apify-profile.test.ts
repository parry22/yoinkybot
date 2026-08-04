import { describe, expect, it } from "vitest";
import { normalizeXHandle, normalizeLinkedInUsername, parseXItems, parseLinkedInItems } from "./apify-profile.js";

describe("normalizeXHandle", () => {
  it("extracts a handle from a profile URL", () => {
    expect(normalizeXHandle("https://x.com/naval")).toBe("naval");
    expect(normalizeXHandle("https://twitter.com/naval")).toBe("naval");
  });
  it("strips a leading @ from a bare handle", () => {
    expect(normalizeXHandle("@Naval")).toBe("naval");
  });
});

describe("normalizeLinkedInUsername", () => {
  it("extracts the username from a profile URL", () => {
    expect(normalizeLinkedInUsername("https://www.linkedin.com/in/satyanadella")).toBe("satyanadella");
  });
  it("strips in/ and @ prefixes from a bare slug", () => {
    expect(normalizeLinkedInUsername("in/satyanadella")).toBe("satyanadella");
    expect(normalizeLinkedInUsername("@satyanadella")).toBe("satyanadella");
  });
});

// Field shapes below are trimmed from a live run of
// kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest (2026-07-04).
describe("parseXItems", () => {
  const items = [
    {
      type: "tweet",
      id: "2073267613380259840",
      url: "https://x.com/naval/status/2073267613380259840",
      twitterUrl: "https://twitter.com/naval/status/2073267613380259840",
      text: "Happy Birthday America, Land of the Free.",
      retweetCount: 2082,
      likeCount: 16817,
      createdAt: "Sat Jul 04 04:48:13 +0000 2026",
      isReply: false,
      author: { userName: "naval", followers: 3567042, description: "" },
    },
    { noResults: true },
    { type: "tweet", id: "2", text: "a reply", isReply: true, createdAt: "Sat Jul 04 04:48:13 +0000 2026" },
  ];

  it("parses the real tweet fields and skips noResults/reply rows", () => {
    const { posts, followers } = parseXItems(items, "naval");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe("Happy Birthday America, Land of the Free.");
    expect(posts[0]!.url).toBe("https://x.com/naval/status/2073267613380259840");
    expect(posts[0]!.postedAt.getUTCFullYear()).toBe(2026);
    expect(followers).toBe(3567042);
  });
});

// Field shapes below are trimmed from a live run of apimaestro/linkedin-profile-posts.
describe("parseLinkedInItems", () => {
  const items = [
    {
      urn: { activity_urn: "7478576429031649281" },
      posted_at: { date: "2026-07-03 00:32:45", timestamp: 1783031565912 },
      text: "Reflecting on 250 years of American history.",
      url: "https://www.linkedin.com/posts/bradsmi_america250",
      post_type: "repost",
    },
    {
      posted_at: { timestamp: 1783031565912 },
      text: "My actual original take on distribution.",
      url: "https://www.linkedin.com/posts/someone_take",
      post_type: "post",
      stats: { total_reactions: 42, comments: 7, reposts: 3 },
      media: { type: "image", images: ["https://media.licdn.com/chart.jpg"] },
    },
  ];

  it("skips reposts and keeps original posts", () => {
    const posts = parseLinkedInItems(items);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe("My actual original take on distribution.");
    expect(posts[0]!.postedAt.getTime()).toBe(1783031565912);
    expect(posts[0]!.engagement).toMatchObject({ likeCount: 42, replyCount: 7, retweetCount: 3 });
    expect(posts[0]!.media).toEqual([
      { kind: "image", url: "https://media.licdn.com/chart.jpg", mimeType: "image/jpeg" },
    ]);
  });
});
