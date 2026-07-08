import { describe, it, expect } from "vitest";
import { detectConnectIntent, parseConnectTarget } from "./bot.js";

describe("detectConnectIntent", () => {
  it("catches the plain-language diagnosis request that regressed", () => {
    expect(detectConnectIntent("can you do a detailed brand diagnosis on my x: @wtfparry")).toEqual({
      platform: "x",
      handle: "wtfparry",
    });
  });

  it("reads a bare X handle with an intent verb", () => {
    expect(detectConnectIntent("diagnose my twitter @foo_bar")).toEqual({ platform: "x", handle: "foo_bar" });
  });

  it("takes an X profile URL", () => {
    expect(detectConnectIntent("analyze https://x.com/wtfparry please")).toEqual({
      platform: "x",
      handle: "wtfparry",
    });
  });

  it("takes a LinkedIn profile URL even without a verb", () => {
    expect(detectConnectIntent("here: https://linkedin.com/in/parry-singh")).toEqual({
      platform: "linkedin",
      handle: "parry-singh",
    });
  });

  it("reads a LinkedIn handle with a verb", () => {
    expect(detectConnectIntent("connect my linkedin @parrysingh")).toEqual({
      platform: "linkedin",
      handle: "parrysingh",
    });
  });

  it("does not fire without a concrete handle", () => {
    expect(detectConnectIntent("I want to grow my presence on X")).toBeNull();
    expect(detectConnectIntent("read my linkedin sometime")).toBeNull();
  });

  it("does not fire on ordinary chat", () => {
    expect(detectConnectIntent("what have I said about pricing?")).toBeNull();
    expect(detectConnectIntent("hey @someone what do you think")).toBeNull();
  });

  it("ignores non-profile x.com URLs", () => {
    expect(detectConnectIntent("check out x.com/home for me")).toBeNull();
  });
});

describe("parseConnectTarget", () => {
  it("the screenshot case: a bare @handle reply", () => {
    expect(parseConnectTarget("@wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: true });
  });

  it("a bare handle without @ parses but is not explicit", () => {
    expect(parseConnectTarget("wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: false });
  });

  it("platform-prefixed forms are explicit", () => {
    expect(parseConnectTarget("x wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: true });
    expect(parseConnectTarget("twitter @wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: true });
  });

  it("bare LinkedIn profile URL", () => {
    expect(parseConnectTarget("https://www.linkedin.com/in/parry-singh/")).toEqual({
      platform: "linkedin",
      handle: "parry-singh",
      explicit: true,
    });
  });

  it("never treats small talk as a handle", () => {
    for (const t of ["hello", "hey", "thanks", "ok", "yes", "help"]) {
      expect(parseConnectTarget(t)).toBeNull();
    }
  });

  it("but @-prefixed small-talk words are taken literally", () => {
    expect(parseConnectTarget("@ok")).toEqual({ platform: "x", handle: "ok", explicit: true });
  });

  it("rejects sentences and over-long handles", () => {
    expect(parseConnectTarget("my handle is wtfparry btw")).toBeNull();
    expect(parseConnectTarget("thisistoolongforanxhandle")).toBeNull();
  });

  it("the stuck case: platform with a colon", () => {
    expect(parseConnectTarget("x: @wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: true });
    expect(parseConnectTarget("x: wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: true });
  });

  it("short natural phrasings with platform + @handle", () => {
    expect(parseConnectTarget("my x is @wtfparry")).toEqual({ platform: "x", handle: "wtfparry", explicit: true });
    expect(parseConnectTarget("on twitter @foo_bar")).toEqual({ platform: "x", handle: "foo_bar", explicit: true });
    expect(parseConnectTarget("linkedin: @parrysingh")).toEqual({
      platform: "linkedin",
      handle: "parrysingh",
      explicit: true,
    });
  });

  it("long sentences mentioning x and an @name stay null", () => {
    expect(parseConnectTarget("I was on x yesterday and saw @foo post something wild")).toBeNull();
  });
});
