import { InlineKeyboard } from "grammy";
import { query,queryOne } from "../db/pool.js";
import { extractTranscriptToKnowledge,listKnowledgeObjects,reviewKnowledgeObject } from "../knowledge/service.js";
import { approveContentAsset,approveContentBrief,listContentAssets,listContentBriefs,rejectContentAsset } from "../production/service.js";
import { listWorkspacesForUser,requireWorkspaceRole,resolveTelegramCaptureWorkspace,setTelegramWorkspaceContext } from "../workspaces/service.js";
import type { Channel } from "./actions.js";

export type CompanyTelegramCallbackAction = "sw" | "ka" | "kr" | "ba" | "aa" | "ar";

export type ParsedCompanyTelegramCallback =
  | { action: "sw"; workspaceId: string }
  | { action: Exclude<CompanyTelegramCallbackAction, "sw">; workspaceId: string; itemId: string };

export function parseCompanyTelegramCallback(data: string): ParsedCompanyTelegramCallback | null {
  const switchMatch = /^cw:sw:([0-9a-f-]{36})$/.exec(data);
  if (switchMatch) return { action: "sw", workspaceId: switchMatch[1]! };

  const itemMatch = /^cw:(ka|kr|ba|aa|ar):([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(data);
  if (itemMatch) {
    return {
      action: itemMatch[1] as Exclude<CompanyTelegramCallbackAction, "sw">,
      workspaceId: itemMatch[2]!,
      itemId: itemMatch[3]!,
    };
  }

  return null;
}

export function companyTelegramCallbackData(
  action: Exclude<CompanyTelegramCallbackAction, "sw">,
  workspaceId: string,
  itemId: string,
): string {
  return `cw:${action}:${workspaceId}:${itemId}`;
}

export type CompanyTelegramIntent=
  |{kind:"list_workspaces"}|{kind:"switch_workspace";name:string}|{kind:"capture";workspaceName:string;content:string}
  |{kind:"knowledge_inbox"}|{kind:"brief_inbox"}|{kind:"asset_inbox"}|{kind:"telegram_delivery";enabled:boolean};

export function parseCompanyTelegramIntent(text:string):CompanyTelegramIntent|null{
  const value=text.trim();
  if(/^(show|list) (my )?workspaces[.!]?$/i.test(value))return{kind:"list_workspaces"};
  const switchMatch=/^switch to (?:the )?workspace\s+(.+?)[.!]?$/i.exec(value);if(switchMatch)return{kind:"switch_workspace",name:switchMatch[1]!.trim()};
  const capture=/^capture (?:this|the following) for (?:the )?workspace\s+([^:]+):\s*([\s\S]+)$/i.exec(value);if(capture)return{kind:"capture",workspaceName:capture[1]!.trim(),content:capture[2]!.trim()};
  if(/^show (?:the )?knowledge inbox[.!]?$/i.test(value))return{kind:"knowledge_inbox"};
  if(/^show (?:the )?(?:briefs|brief inbox)[.!]?$/i.test(value))return{kind:"brief_inbox"};
  if(/^show (?:the )?(?:drafts|content approvals|draft inbox)[.!]?$/i.test(value))return{kind:"asset_inbox"};
  if(/^enable telegram (?:delivery )?for this workspace[.!]?$/i.test(value))return{kind:"telegram_delivery",enabled:true};
  if(/^disable telegram (?:delivery )?for this workspace[.!]?$/i.test(value))return{kind:"telegram_delivery",enabled:false};
  return null;
}

export function telegramItemVisible(input:{hasWorkspaceAccess:boolean;deliveryEnabled:boolean;permissionLevel:string}):boolean{return input.hasWorkspaceAccess&&input.deliveryEnabled&&["public","internal"].includes(input.permissionLevel);}

async function deliveryAllowed(userId:string,workspaceId:string){const row=await queryOne<{workspace_type:string;enabled:boolean}>(`SELECT w.workspace_type,coalesce((w.settings->>'telegram_delivery')::boolean,false) enabled FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id WHERE w.id=$1 AND wm.user_id=$2`,[workspaceId,userId]);return !!row&&(row.workspace_type==="personal"||row.enabled);}
async function requireDelivery(userId:string,workspaceId:string,channel:Channel){if(await deliveryAllowed(userId,workspaceId))return true;await channel.say("Telegram delivery is off for this company workspace. An admin can say \"enable Telegram for this workspace\" before company knowledge or approvals appear here.");return false;}

export async function handleCompanyTelegramIntent(userId:string,intent:CompanyTelegramIntent,channel:Channel):Promise<void>{
  if(intent.kind==="list_workspaces"){const workspaces=await listWorkspacesForUser(userId);const kb=new InlineKeyboard();for(const workspace of workspaces)kb.text(`${workspace.active?"✓ ":""}${workspace.name}`,`cw:sw:${workspace.id}`).row();await channel.say("Choose the workspace this Telegram conversation should use. I will never guess for a company capture.",kb);return;}
  if(intent.kind==="switch_workspace"){const workspaces=await listWorkspacesForUser(userId);const matches=workspaces.filter(item=>item.name.toLowerCase()===intent.name.toLowerCase());if(matches.length!==1){await channel.say(matches.length===0?"I could not find that workspace. Say \"show my workspaces\" to choose one.":"That name is ambiguous. Say \"show my workspaces\" to choose the exact workspace.");return;}const workspace=await setTelegramWorkspaceContext(userId,matches[0]!.id);await channel.say(`Current Telegram workspace: ${workspace.name}. Voice notes will be filed there until you switch again.`);return;}
  if(intent.kind==="capture"){const workspaces=await listWorkspacesForUser(userId);const matches=workspaces.filter(item=>item.name.toLowerCase()===intent.workspaceName.toLowerCase());if(matches.length!==1){await channel.say("I need one exact workspace name for a company capture. Say \"show my workspaces\" first.");return;}const workspace=matches[0]!;await requireWorkspaceRole(userId,workspace.id,"contributor");if(intent.content.length<80){await channel.say("Give me a little more context, at least a short paragraph, so I do not turn a fragment into false company knowledge.");return;}const objects=await extractTranscriptToKnowledge(userId,workspace.id,{title:`Telegram capture, ${new Date().toISOString().slice(0,10)}`,transcript:intent.content,permissionLevel:"internal"});await channel.say(`Captured for ${workspace.name}. I extracted ${objects.length} proposed knowledge item${objects.length===1?"":"s"} for human review.`);return;}
  const workspace=await resolveTelegramCaptureWorkspace(userId);if(!workspace){await channel.say("Choose a workspace in the web app first.");return;}
  if(intent.kind==="telegram_delivery"){await requireWorkspaceRole(userId,workspace.id,"admin");await query(`UPDATE workspaces SET settings=jsonb_set(settings,'{telegram_delivery}',$3::jsonb,true),updated_at=now() WHERE id=$1`,[workspace.id,userId,JSON.stringify(intent.enabled)]);await channel.say(`Telegram delivery is ${intent.enabled?"enabled":"disabled"} for ${workspace.name}.`);return;}
  if(!await requireDelivery(userId,workspace.id,channel))return;
  if(intent.kind==="knowledge_inbox"){const items=(await listKnowledgeObjects(userId,workspace.id)).filter(item=>item.status==="proposed"&&["public","internal"].includes(item.permissionLevel)).slice(0,8);if(!items.length){await channel.say("The accessible knowledge inbox is clear.");return;}await channel.say(`Knowledge inbox for ${workspace.name}:`);for(const item of items){const kb=new InlineKeyboard().text("Approve",companyTelegramCallbackData("ka",workspace.id,item.id)).text("Reject",companyTelegramCallbackData("kr",workspace.id,item.id));await channel.say(`${item.objectType.replaceAll("_"," ")}: ${item.title}\n${item.body.slice(0,500)}`,kb);}return;}
  if(intent.kind==="brief_inbox"){const items=(await listContentBriefs(userId,workspace.id)).filter(item=>item.status==="draft").slice(0,8);if(!items.length){await channel.say("No briefs are waiting for approval.");return;}for(const item of items)await channel.say(`${item.channel.toUpperCase()} brief: ${item.objective}\nBelief shift: ${item.desiredBeliefShift}`,new InlineKeyboard().text("Approve brief",companyTelegramCallbackData("ba",workspace.id,item.id)));return;}
  const assets=(await listContentAssets(userId,workspace.id)).filter(item=>item.status==="needs_review").slice(0,8);if(!assets.length){await channel.say("No drafts are waiting for approval.");return;}for(const item of assets)await channel.say(`${item.assetType.replaceAll("_"," ")}: ${item.title}\n\n${item.content.slice(0,1200)}`,new InlineKeyboard().text("Approve",companyTelegramCallbackData("aa",workspace.id,item.id)).text("Reject",companyTelegramCallbackData("ar",workspace.id,item.id)));
}

export async function handleCompanyTelegramCallback(userId:string,data:string,channel:Channel):Promise<string|null>{
  const parsed=parseCompanyTelegramCallback(data);if(!parsed)return null;
  if(parsed.action==="sw"){const workspace=await setTelegramWorkspaceContext(userId,parsed.workspaceId);return `Current Telegram workspace: ${workspace.name}. Voice notes will be filed there until you switch again.`;}
  if(!await deliveryAllowed(userId,parsed.workspaceId))throw new Error("Telegram delivery is disabled for this workspace.");
  if(parsed.action==="ka"||parsed.action==="kr"){const item=await reviewKnowledgeObject(userId,parsed.workspaceId,parsed.itemId,parsed.action==="ka"?"approved":"rejected");return `${item.title}: ${item.status}.`;}
  if(parsed.action==="ba"){const brief=await approveContentBrief(userId,parsed.workspaceId,parsed.itemId);return `Brief approved: ${brief.objective}`;}
  if(parsed.action==="aa"){const asset=await approveContentAsset(userId,parsed.workspaceId,parsed.itemId,"Approved from Telegram");return `Asset approved: ${asset.title}`;}
  const asset=await rejectContentAsset(userId,parsed.workspaceId,parsed.itemId,"Rejected from Telegram");return `Asset rejected: ${asset.title}`;
}
