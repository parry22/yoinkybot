import { describe, expect, it } from "vitest";
import { parseChatTool } from "./telegram/chat-tools.js";
import { parseCompanyTelegramIntent } from "./telegram/workspaces.js";
import { EMPTY_SPEC, nextSlot, type AgentSpec } from "./automations/interview.js";
import { analyzePosts, type PerfPost } from "./strategist/performance.js";
import { entitlementsForPlan } from "./billing/entitlements.js";

describe("personal product compatibility after the company-engine pivot", () => {
  it("keeps personal drafting and both publishing channels in the chat contract", () => {
    expect(parseChatTool({ name: "draft_post", platform: "x", topic: "launch notes" })).toMatchObject({
      name: "draft_post",
      platform: "x",
    });
    expect(
      parseChatTool({
        name: "schedule_post",
        platform: "x",
        content: "X draft",
        when: "2026-08-07T09:00:00.000Z",
      }),
    ).toMatchObject({ name: "schedule_post", platform: "x" });
    expect(
      parseChatTool({
        name: "schedule_post",
        platform: "linkedin",
        content: "LinkedIn draft",
        when: "2026-08-07T09:00:00.000Z",
      }),
    ).toMatchObject({ name: "schedule_post", platform: "linkedin" });
  });

  it("does not let company routing intercept ordinary personal Telegram capture", () => {
    expect(parseCompanyTelegramIntent("capture this thought about founder-led sales")).toBeNull();
    expect(parseCompanyTelegramIntent("capture this for workspace Acme: Buyers need proof before a pilot")).toMatchObject({
      kind: "capture",
      workspaceName: "Acme",
    });
  });

  it("keeps the personal automation interview bounded to three grouped questions", () => {
    const seen: string[] = [];
    let current: AgentSpec = EMPTY_SPEC;
    for (;;) {
      const slot = nextSlot(current);
      if (!slot) break;
      seen.push(String(slot.key));
      const patch: Partial<AgentSpec> = {};
      for (const key of slot.keys) {
        if (key === "postTypes" || key === "angles" || key === "hooks") patch[key] = ["filled"];
        else if (key === "platform") patch.platform = "x";
        else if (key === "source") patch.source = "custom";
        else if (key === "cadence") patch.cadence = "weekly";
        else if (key === "delivery") patch.delivery = "approval";
        else patch[key] = "filled" as never;
      }
      current = { ...current, ...patch };
    }
    expect(seen).toEqual(["purpose", "postTypes", "platform"]);
  });

  it("keeps creator analytics deterministic for X and LinkedIn history", () => {
    const now = Date.UTC(2026, 7, 6);
    const posts: PerfPost[] = [
      {
        platform: "x",
        engagement: 12,
        capturedAt: now - 20 * 86_400_000,
        alignedDistance: null,
        orientation: null,
        content: "baseline",
        url: null,
        unlockIdea: null,
      },
      {
        platform: "linkedin",
        engagement: 24,
        capturedAt: now - 2 * 86_400_000,
        alignedDistance: 0.2,
        orientation: "inside_out",
        content: "current",
        url: null,
        unlockIdea: null,
      },
    ];
    const result = analyzePosts(posts, now - 7 * 86_400_000, now);
    expect(result.baseline).toEqual({ posts: 1, median: 12 });
    expect(result.period).toMatchObject({ posts: 1, withEngagement: 1, median: 24 });
  });

  it("keeps Growth and Scale billing behavior intact", () => {
    expect(entitlementsForPlan("paid")).toMatchObject({
      plan: "paid",
      automationPostsPerMonth: 30,
      autoAgent: false,
      drafting: true,
    });
    expect(entitlementsForPlan("scale")).toMatchObject({
      plan: "scale",
      automationPostsPerMonth: 90,
      autoAgent: true,
      drafting: true,
    });
  });
});
