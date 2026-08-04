import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db/pool.js", () => ({ query: db.query, queryOne: vi.fn() }));

import { uploadMediaFor, type ScheduledMedia } from "./media.js";

const auth = { accessToken: "token", authorUrn: "urn:li:person:me" };

afterEach(() => {
  vi.unstubAllGlobals();
  db.query.mockReset();
});

describe("LinkedIn media upload", () => {
  it("initializes and uploads an image, returning its image URN", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("images?action=initializeUpload")) {
        return Response.json({ value: { uploadUrl: "https://upload.linkedin.test/image", image: "urn:li:image:1" } });
      }
      if (url === "https://pbs.twimg.com/media/chart.jpg") return new Response(new Uint8Array([1, 2, 3]));
      if (url === "https://upload.linkedin.test/image") return new Response("", { status: 201 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const item: ScheduledMedia = {
      id: "media-1",
      kind: "image",
      url: "https://pbs.twimg.com/media/chart.jpg",
      mimeType: "image/jpeg",
      byteSize: 3,
      altText: "A chart",
      externalMediaId: null,
    };

    await expect(uploadMediaFor(auth, "linkedin", [item])).resolves.toEqual({ ok: true, mediaIds: ["urn:li:image:1"] });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("external_media_id"), ["media-1", "urn:li:image:1"]);
  });

  it("uploads every instructed video part and finalizes the video", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://video.twimg.com/clip.mp4") return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.includes("videos?action=initializeUpload")) {
        return Response.json({
          value: {
            video: "urn:li:video:1",
            uploadToken: "upload-token",
            uploadInstructions: [
              { uploadUrl: "https://upload.linkedin.test/part-1", firstByte: 0, lastByte: 1 },
              { uploadUrl: "https://upload.linkedin.test/part-2", firstByte: 2, lastByte: 3 },
            ],
          },
        });
      }
      if (url.includes("upload.linkedin.test/part-")) {
        const suffix = url.endsWith("1") ? "one" : "two";
        return new Response("", { status: 200, headers: { etag: suffix } });
      }
      if (url.includes("videos?action=finalizeUpload")) {
        const body = JSON.parse(String(init?.body));
        expect(body.finalizeUploadRequest.uploadedPartIds).toEqual(["one", "two"]);
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const item: ScheduledMedia = {
      id: "media-2",
      kind: "video",
      url: "https://video.twimg.com/clip.mp4",
      mimeType: "video/mp4",
      byteSize: 4,
      altText: null,
      externalMediaId: null,
    };

    await expect(uploadMediaFor(auth, "linkedin", [item])).resolves.toEqual({ ok: true, mediaIds: ["urn:li:video:1"] });
  });
});
