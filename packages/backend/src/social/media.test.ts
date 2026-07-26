import { describe, expect, it } from "vitest";
import { kindForMime, maxBytesFor, validateMediaSet, MEDIA_LIMITS } from "./media.js";

describe("kindForMime", () => {
  it("maps the formats X accepts", () => {
    expect(kindForMime("image/jpeg")).toBe("image");
    expect(kindForMime("image/png")).toBe("image");
    expect(kindForMime("image/webp")).toBe("image");
    expect(kindForMime("video/mp4")).toBe("video");
    expect(kindForMime("video/quicktime")).toBe("video");
  });

  // GIF is image/* but is NOT an image for posting purposes — it can't be one of
  // four, and it has its own size ceiling.
  it("treats GIF as its own kind, not an image", () => {
    expect(kindForMime("image/gif")).toBe("gif");
  });

  it("is case-insensitive about the mime type", () => {
    expect(kindForMime("IMAGE/JPEG")).toBe("image");
  });

  it("rejects anything else", () => {
    expect(kindForMime("application/pdf")).toBeNull();
    expect(kindForMime("image/tiff")).toBeNull();
    expect(kindForMime("")).toBeNull();
  });
});

describe("maxBytesFor", () => {
  it("gives each kind its own ceiling", () => {
    expect(maxBytesFor("image")).toBe(MEDIA_LIMITS.maxImageBytes);
    expect(maxBytesFor("gif")).toBe(MEDIA_LIMITS.maxGifBytes);
    expect(maxBytesFor("video")).toBe(MEDIA_LIMITS.maxVideoBytes);
  });

  it("allows a video to be far larger than an image", () => {
    expect(maxBytesFor("video")).toBeGreaterThan(maxBytesFor("image"));
  });
});

describe("validateMediaSet (X's one-video-or-four-images rule)", () => {
  const items = (...kinds: Array<"image" | "gif" | "video">) => kinds.map((kind) => ({ kind }));

  it("accepts no media at all", () => {
    expect(validateMediaSet([])).toBeNull();
  });

  it("accepts up to four images", () => {
    expect(validateMediaSet(items("image"))).toBeNull();
    expect(validateMediaSet(items("image", "image", "image", "image"))).toBeNull();
  });

  it("rejects a fifth image", () => {
    expect(validateMediaSet(items("image", "image", "image", "image", "image"))?.reason).toContain("4 images");
  });

  it("accepts one video alone", () => {
    expect(validateMediaSet(items("video"))).toBeNull();
  });

  it("rejects two videos", () => {
    expect(validateMediaSet(items("video", "video"))?.reason).toContain("one video");
  });

  // The mixing rules are the ones a UI is most likely to let through, so they are
  // enforced here where both the scheduler and the publisher can see them.
  it("refuses to mix a video with images", () => {
    expect(validateMediaSet(items("video", "image"))?.reason).toContain("video");
  });

  it("refuses to mix a GIF with images", () => {
    expect(validateMediaSet(items("gif", "image"))?.reason).toContain("GIF");
  });

  it("refuses two GIFs", () => {
    expect(validateMediaSet(items("gif", "gif"))?.reason).toContain("one GIF");
  });

  it("accepts one GIF alone", () => {
    expect(validateMediaSet(items("gif"))).toBeNull();
  });
});
