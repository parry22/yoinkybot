import { describe, expect, it } from "vitest";
import { parseTwitterApiIoTweets } from "./twitterapi-io.js";

// Field shapes from https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets
describe("parseTwitterApiIoTweets", () => {
  const tweets = [
    {
      id: "2073267613380259840",
      url: "https://x.com/naval/status/2073267613380259840",
      text: "Happy Birthday America, Land of the Free.",
      createdAt: "Sat Jul 04 04:48:13 +0000 2026",
      isReply: false,
      retweetCount: 2082,
      replyCount: 40,
      likeCount: 16817,
      quoteCount: 12,
      viewCount: 900000,
      bookmarkCount: 300,
      conversationId: "2073267613380259840",
      author: { followers: 3567042, description: "Naval" },
      extendedEntities: {
        media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/chart.jpg", ext_alt_text: "A chart" }],
      },
    },
    { id: "2", text: "a reply", isReply: true, createdAt: "Sat Jul 04 04:48:13 +0000 2026" },
    { id: "3", text: "RT text", retweeted_tweet: { id: "999" }, createdAt: "Sat Jul 04 04:48:13 +0000 2026" },
    { id: "4", text: "", createdAt: "Sat Jul 04 04:48:13 +0000 2026" },
  ];

  it("keeps only original posts, carrying engagement + bio + followers", () => {
    const { posts, bio, followers } = parseTwitterApiIoTweets(tweets);
    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.text).toBe("Happy Birthday America, Land of the Free.");
    expect(p.url).toBe("https://x.com/naval/status/2073267613380259840");
    expect(p.postedAt.getUTCFullYear()).toBe(2026);
    expect(p.engagement).toEqual({
      likeCount: 16817,
      replyCount: 40,
      retweetCount: 2082,
      quoteCount: 12,
      viewCount: 900000,
      bookmarkCount: 300,
      isReply: false,
      conversationId: "2073267613380259840",
    });
    expect(bio).toBe("Naval");
    expect(followers).toBe(3567042);
    expect(p.media).toEqual([
      { kind: "image", url: "https://pbs.twimg.com/media/chart.jpg", mimeType: "image/jpeg", altText: "A chart" },
    ]);
  });

  it("excludes replies and pure retweets", () => {
    const { posts } = parseTwitterApiIoTweets(tweets);
    expect(posts.some((p) => p.text === "a reply")).toBe(false);
    expect(posts.some((p) => p.text === "RT text")).toBe(false);
  });

  it("handles an empty feed", () => {
    expect(parseTwitterApiIoTweets([])).toEqual({ posts: [], bio: undefined, followers: undefined });
  });

  it("falls back to now() for an unparsable date", () => {
    const { posts } = parseTwitterApiIoTweets([{ id: "5", text: "no real date", createdAt: "garbage" }]);
    expect(posts[0]!.postedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(posts[0]!.postedAt.getTime())).toBe(false);
  });
});
