import { config } from "../../config.js";
import { runApifyActor, str, num } from "../../lib/apify.js";
import type { ImportedPost } from "./x.js";
import { pullXProfileViaTwitterApiIo, MAX_OWN_TWEETS } from "./twitterapi-io.js";

export interface ProfilePull {
  posts: ImportedPost[];
  meta: { bio?: string; followers?: number; handle: string };
}

/** Normalize a raw @handle / URL into a bare handle for X. */
export function normalizeXHandle(input: string): string {
  const m = input.trim().match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/);
  return (m?.[1] ?? input.trim().replace(/^@/, "")).toLowerCase();
}

/** Normalize a LinkedIn profile URL/slug into the bare username the actor expects. */
export function normalizeLinkedInUsername(input: string): string {
  const s = input.trim();
  const m = s.match(/linkedin\.com\/in\/([^/?]+)/);
  return (m?.[1] ?? s.replace(/^@/, "").replace(/^in\//, "")).toLowerCase();
}

/**
 * Parse raw items from kaitoeasyapi/twitter-x-data-tweet-scraper into posts.
 * Verified field shape against a live Apify run 2026-07-04: text, id, url/
 * twitterUrl, createdAt ("Sat Jul 04 04:48:13 +0000 2026"), author.userName.
 */
export function parseXItems(items: unknown[], handle: string): { posts: ImportedPost[]; bio?: string; followers?: number } {
  const posts: ImportedPost[] = [];
  let bio: string | undefined;
  let followers: number | undefined;
  for (const raw of items) {
    const t = raw as Record<string, unknown>;
    if (t["noResults"]) continue;
    const author = (t["author"] ?? {}) as Record<string, unknown>;
    bio ??= str(author["description"]) || undefined;
    followers ??= num(author["followers"]) || undefined;

    const text = str(t["text"]);
    if (!text || t["isReply"] === true) continue; // own original posts only
    const id = str(t["id"]);
    const created = t["createdAt"];
    const date = created ? new Date(String(created)) : new Date();
    posts.push({
      text,
      postedAt: Number.isNaN(date.getTime()) ? new Date() : date,
      url: str(t["url"] ?? t["twitterUrl"]) || (id ? `https://x.com/${handle}/status/${id}` : undefined),
      engagement: {
        likeCount: num(t["likeCount"]) || undefined,
        replyCount: num(t["replyCount"]) || undefined,
        retweetCount: num(t["retweetCount"]) || undefined,
        quoteCount: num(t["quoteCount"]) || undefined,
        viewCount: num(t["viewCount"]) || undefined,
        isReply: false,
      },
    });
  }
  return { posts, bio, followers };
}

/** Pull a user's public X history via kaitoeasyapi/twitter-x-data-tweet-scraper (from:handle). */
async function pullXProfileViaApify(handle: string, maxPosts = MAX_OWN_TWEETS): Promise<ProfilePull> {
  maxPosts = Math.min(maxPosts, MAX_OWN_TWEETS);
  const h = normalizeXHandle(handle);
  const items = await runApifyActor(config.APIFY_X_PROFILE_ACTOR, {
    from: h,
    maxItems: maxPosts,
    queryType: "Latest",
  });
  const { posts, bio, followers } = parseXItems(items, h);
  return { posts, meta: { bio, followers, handle: h } };
}

/**
 * Pull a user's public X history. Prefers twitterapi.io when configured - it
 * returns engagement counts and thread context the Apify actor doesn't expose -
 * and falls back to Apify when TWITTERAPI_IO_KEY is unset. `window` lets the
 * twitterapi path stop paginating early once past the recency cutoff; the
 * Apify actor has no such control, so its result is windowed by the caller.
 */
export async function pullXProfile(
  handle: string,
  maxPosts = MAX_OWN_TWEETS,
  window?: { sinceDays: number; minPosts: number },
): Promise<ProfilePull> {
  maxPosts = Math.min(maxPosts, MAX_OWN_TWEETS);
  if (config.TWITTERAPI_IO_KEY) return pullXProfileViaTwitterApiIo(normalizeXHandle(handle), maxPosts, window);
  return pullXProfileViaApify(handle, maxPosts);
}

/**
 * Parse raw items from apimaestro/linkedin-profile-posts into posts. Verified
 * field shape against a live Apify run 2026-07-04: text, url, posted_at.date,
 * post_type ("repost" excluded - not the user's own words).
 */
export function parseLinkedInItems(items: unknown[]): ImportedPost[] {
  const posts: ImportedPost[] = [];
  for (const raw of items) {
    const t = raw as Record<string, unknown>;
    if (t["post_type"] === "repost") continue; // own words only
    const text = str(t["text"]);
    if (!text) continue;
    const postedAt = (t["posted_at"] ?? {}) as Record<string, unknown>;
    const created = postedAt["timestamp"] ?? postedAt["date"];
    const date = created
      ? typeof created === "number"
        ? new Date(created)
        : new Date(String(created))
      : new Date();
    const stats = (t["stats"] ?? {}) as Record<string, unknown>;
    const hasStats = ["total_reactions", "likes", "comments", "reposts", "shares"].some(
      (key) => typeof stats[key] === "number",
    );
    const mediaRaw = t["media"];
    const mediaObjects = Array.isArray(mediaRaw) ? mediaRaw : mediaRaw && typeof mediaRaw === "object" ? [mediaRaw] : [];
    const media: NonNullable<ImportedPost["media"]> = [];
    for (const value of mediaObjects) {
      const m = value as Record<string, unknown>;
      const type = str(m["type"]).toLowerCase();
      const direct = str(m["url"]);
      if (direct) {
        media.push({
          kind: type.includes("video") ? "video" : type.includes("gif") ? "gif" : "image",
          url: direct,
          mimeType: type.includes("video") ? "video/mp4" : type.includes("gif") ? "image/gif" : "image/jpeg",
          altText: str(m["alt_text"] ?? m["altText"]) || undefined,
        });
      }
      const images = Array.isArray(m["images"]) ? m["images"] : [];
      for (const image of images) {
        const url = typeof image === "string" ? image : str((image as Record<string, unknown>)["url"]);
        if (url && !media.some((existing) => existing.url === url)) {
          media.push({ kind: "image", url, mimeType: "image/jpeg" });
        }
      }
    }
    posts.push({
      text,
      postedAt: Number.isNaN(date.getTime()) ? new Date() : date,
      url: str(t["url"]) || undefined,
      ...(hasStats
        ? {
            engagement: {
              likeCount: num(stats["total_reactions"] ?? stats["likes"]),
              replyCount: num(stats["comments"]),
              retweetCount: num(stats["reposts"] ?? stats["shares"]),
              quoteCount: 0,
            },
          }
        : {}),
      media,
    });
  }
  return posts;
}

/** Pull a user's public LinkedIn posts via apimaestro/linkedin-profile-posts. */
export async function pullLinkedInProfile(urlOrSlug: string, maxPosts = 100): Promise<ProfilePull> {
  const username = normalizeLinkedInUsername(urlOrSlug);
  const items = await runApifyActor(config.APIFY_LINKEDIN_PROFILE_ACTOR, {
    username,
    page_number: 1,
    limit: maxPosts,
  });
  return { posts: parseLinkedInItems(items), meta: { handle: username } };
}
