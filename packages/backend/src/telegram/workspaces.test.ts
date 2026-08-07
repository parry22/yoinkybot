import { describe,expect,it } from "vitest";
import { parseCompanyTelegramIntent } from "./workspaces.js";
describe("company workspace Telegram intents",()=>{
  it("requires an explicit workspace on company capture",()=>{expect(parseCompanyTelegramIntent("capture this thought")).toBeNull();expect(parseCompanyTelegramIntent("capture this for workspace Acme: Customers keep asking for a deployment audit before they move production workloads into the platform.")).toMatchObject({kind:"capture",workspaceName:"Acme"});});
  it("recognizes workspace switching without guessing",()=>expect(parseCompanyTelegramIntent("switch to workspace Acme Labs")).toEqual({kind:"switch_workspace",name:"Acme Labs"}));
  it("recognizes bounded inbox actions",()=>{expect(parseCompanyTelegramIntent("show knowledge inbox")).toEqual({kind:"knowledge_inbox"});expect(parseCompanyTelegramIntent("show briefs")).toEqual({kind:"brief_inbox"});expect(parseCompanyTelegramIntent("show content approvals")).toEqual({kind:"asset_inbox"});});
});
