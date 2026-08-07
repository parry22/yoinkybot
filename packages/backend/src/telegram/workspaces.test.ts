import { describe, expect, it } from "vitest";
import { telegramCaptureWorkspacePreferenceOrder } from "../workspaces/service.js";
import {
  companyTelegramCallbackData,
  parseCompanyTelegramCallback,
  parseCompanyTelegramIntent,
} from "./workspaces.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

describe("company workspace Telegram intents", () => {
  it("requires an explicit workspace on company capture", () => {
    expect(parseCompanyTelegramIntent("capture this thought")).toBeNull();
    expect(
      parseCompanyTelegramIntent(
        "capture this for workspace Acme: Customers keep asking for a deployment audit before they move production workloads into the platform.",
      ),
    ).toMatchObject({ kind: "capture", workspaceName: "Acme" });
  });
  it("recognizes workspace switching without guessing", () =>
    expect(parseCompanyTelegramIntent("switch to workspace Acme Labs")).toEqual({
      kind: "switch_workspace",
      name: "Acme Labs",
    }));
  it("recognizes bounded inbox actions", () => {
    expect(parseCompanyTelegramIntent("show knowledge inbox")).toEqual({ kind: "knowledge_inbox" });
    expect(parseCompanyTelegramIntent("show briefs")).toEqual({ kind: "brief_inbox" });
    expect(parseCompanyTelegramIntent("show content approvals")).toEqual({ kind: "asset_inbox" });
  });
});

describe("Telegram capture workspace precedence", () => {
  it("prefers telegram_workspace_id, then active_workspace_id, then personal", () => {
    expect(telegramCaptureWorkspacePreferenceOrder("tg", "active", "personal")).toEqual([
      "tg",
      "active",
      "personal",
    ]);
    expect(telegramCaptureWorkspacePreferenceOrder(null, "active", "personal")).toEqual([
      "active",
      "personal",
    ]);
    expect(telegramCaptureWorkspacePreferenceOrder(null, null, "personal")).toEqual(["personal"]);
    expect(telegramCaptureWorkspacePreferenceOrder(null, null, null)).toEqual([]);
  });

  it("dedupes when telegram and active point at the same workspace", () => {
    expect(telegramCaptureWorkspacePreferenceOrder("same", "same", "personal")).toEqual([
      "same",
      "personal",
    ]);
  });
});

describe("company Telegram callback parsing", () => {
  it("parses workspace switch callbacks", () => {
    expect(parseCompanyTelegramCallback(`cw:sw:${WORKSPACE_ID}`)).toEqual({
      action: "sw",
      workspaceId: WORKSPACE_ID,
    });
  });

  it("parses approval callbacks with embedded workspace id", () => {
    expect(parseCompanyTelegramCallback(`cw:ka:${WORKSPACE_ID}:${ITEM_ID}`)).toEqual({
      action: "ka",
      workspaceId: WORKSPACE_ID,
      itemId: ITEM_ID,
    });
    expect(companyTelegramCallbackData("ar", WORKSPACE_ID, ITEM_ID)).toBe(
      `cw:ar:${WORKSPACE_ID}:${ITEM_ID}`,
    );
  });

  it("rejects legacy single-id callback format", () => {
    expect(parseCompanyTelegramCallback(`cw:ka:${ITEM_ID}`)).toBeNull();
  });
});
