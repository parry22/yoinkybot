import { afterEach, describe, expect, it, vi } from "vitest";
import { publish } from "./publish.js";

afterEach(() => vi.unstubAllGlobals());

describe("LinkedIn Posts API publishing", () => {
  it("uses the versioned REST endpoint and native text payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await publish(
      { accessToken: "token", authorUrn: "urn:li:person:me" },
      "linkedin",
      "A grounded post",
    );

    expect(result).toMatchObject({ ok: true, externalId: "urn:li:share:123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.linkedin.com/rest/posts");
    expect(init.headers["Linkedin-Version"]).toMatch(/^\d{6}$/);
    expect(JSON.parse(init.body)).toMatchObject({
      author: "urn:li:person:me",
      commentary: "A grounded post",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED" },
    });
  });

  it("publishes multiple uploaded images as a native multi-image post", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:456" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await publish(
      { accessToken: "token", authorUrn: "urn:li:person:me" },
      "linkedin",
      "The charts tell the story",
      ["urn:li:image:a", "urn:li:image:b"],
      [
        { kind: "image", altText: "Before chart" },
        { kind: "image", altText: "After chart" },
      ],
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content.multiImage.images).toEqual([
      { id: "urn:li:image:a", altText: "Before chart" },
      { id: "urn:li:image:b", altText: "After chart" },
    ]);
  });
});
