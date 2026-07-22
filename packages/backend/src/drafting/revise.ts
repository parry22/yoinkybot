/**
 * Revise an existing draft per a free-text instruction. The approval edit-loop's
 * composer. Output is feed content (enforceStyle, never casualized), metered via
 * the gateway like every other draft.
 */
import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { currentVoiceProfile } from "../voice/profile.js";
import { enforceStyle } from "../prompts/style.js";
import { reviseDraftPrompt } from "../prompts/revise-draft.v1.js";

const schema = z.object({ draft: z.string().catch(""), note: z.string().catch("") });

export interface ReviseResult {
  ok: boolean;
  draft: string;
  note: string;
}

export async function reviseDraft(
  userId: string,
  draftText: string,
  instruction: string,
  platform: "x" | "linkedin",
): Promise<ReviseResult> {
  const voice = await currentVoiceProfile(userId);
  const res = await llmCall({
    userId,
    eventType: "draft",
    tier: reviseDraftPrompt.tier,
    system: reviseDraftPrompt.system,
    user: reviseDraftPrompt.render({
      draft: draftText,
      instruction,
      platform,
      voiceTraits: voice?.traits ? JSON.stringify(voice.traits).slice(0, 900) : "",
    }),
    json: true,
    maxTokens: 600,
  });
  const parsed = schema.parse(res.parsed);
  const draft = enforceStyle(parsed.draft.trim());
  return { ok: draft.length > 0, draft, note: parsed.note };
}
