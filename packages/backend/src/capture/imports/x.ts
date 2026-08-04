/**
 * Parser for the X (Twitter) data archive. The archive zip contains
 * `data/tweets.js` shaped as `window.YTD.tweets.part0 = [ { tweet: {...} } ]`.
 * Users upload that file (or any partN file) directly.
 */
export interface ImportedPost {
  text: string;
  postedAt: Date;
  url?: string;
  /** Engagement + thread context, when the source provides it (currently twitterapi.io only). */
  engagement?: {
    likeCount?: number;
    replyCount?: number;
    retweetCount?: number;
    quoteCount?: number;
    viewCount?: number;
    bookmarkCount?: number;
    isReply?: boolean;
    conversationId?: string;
  };
  /** Public source media that can be retained when the post is repurposed. */
  media?: ImportedMedia[];
}

export interface ImportedMedia {
  kind: "image" | "gif" | "video";
  url: string;
  mimeType: string;
  altText?: string;
}

export interface RecencyWindowOpts {
  days: number;
  /** Quality floor: the diagnosis needs ~30-40 posts, so a thin window backfills from older history. */
  minPosts: number;
  maxPosts: number;
}

/**
 * Bound an import to recent history: posts within the window, backfilled with
 * the most recent older posts when the window alone is too thin for a real
 * diagnosis, capped so extraction time stays predictable. Input in any order;
 * output newest-first.
 */
export function applyRecencyWindow(posts: ImportedPost[], opts: RecencyWindowOpts, now = Date.now()): ImportedPost[] {
  const cutoff = now - opts.days * 86_400_000;
  const newestFirst = [...posts].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  const inWindow = newestFirst.filter((p) => p.postedAt.getTime() >= cutoff);
  const picked = inWindow.length >= opts.minPosts ? inWindow : newestFirst.slice(0, opts.minPosts);
  return picked.slice(0, opts.maxPosts);
}

export function parseXArchive(fileContent: string): ImportedPost[] {
  const eq = fileContent.indexOf("=");
  const jsonText = (eq >= 0 && fileContent.slice(0, eq).includes("window.YTD") ? fileContent.slice(eq + 1) : fileContent).trim();
  let entries: unknown;
  try {
    entries = JSON.parse(jsonText);
  } catch {
    throw new Error("Could not parse X archive — upload data/tweets.js from your archive zip");
  }
  if (!Array.isArray(entries)) throw new Error("Unexpected X archive shape");

  const posts: ImportedPost[] = [];
  for (const entry of entries) {
    const t = (entry as { tweet?: Record<string, unknown> }).tweet ?? (entry as Record<string, unknown>);
    const text = String(t["full_text"] ?? t["text"] ?? "").trim();
    if (!text || text.startsWith("RT @")) continue; // skip retweets — not the user's own thinking
    const createdAt = t["created_at"] ? new Date(String(t["created_at"])) : new Date();
    const id = t["id_str"] ? String(t["id_str"]) : undefined;
    posts.push({
      text: decodeXmlEntities(text),
      postedAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      url: id ? `https://x.com/i/status/${id}` : undefined,
    });
  }
  return posts;
}

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
