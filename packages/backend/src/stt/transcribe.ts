import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";

/**
 * Transcribe a voice note. Sarvam first (native Hindi/Hinglish/English), then
 * Groq (fast, cheap hosted Whisper), then OpenAI Whisper as the last resort.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  userId: string,
): Promise<{ text: string; provider: "sarvam" | "groq" | "whisper" }> {
  if (config.SARVAM_API_KEY) {
    try {
      const text = await sarvam(audio, filename);
      await recordUsage({ userId, eventType: "stt", tokensIn: 0, tokensOut: 0, model: "sarvam-saarika", cost: 0 });
      return { text, provider: "sarvam" };
    } catch (err) {
      console.error("sarvam failed, falling back", err);
    }
  }
  if (config.GROQ_API_KEY) {
    try {
      const text = await groq(audio, filename);
      await recordUsage({ userId, eventType: "stt", tokensIn: 0, tokensOut: 0, model: config.GROQ_STT_MODEL, cost: 0 });
      return { text, provider: "groq" };
    } catch (err) {
      console.error("groq stt failed, falling back", err);
    }
  }
  if (config.OPENAI_API_KEY) {
    const text = await whisper(audio, filename);
    await recordUsage({ userId, eventType: "stt", tokensIn: 0, tokensOut: 0, model: "whisper-1", cost: 0 });
    return { text, provider: "whisper" };
  }
  throw new Error("no STT provider configured (SARVAM_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY)");
}

async function sarvam(audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", "saarika:v2.5");
  form.append("language_code", "unknown"); // auto-detect EN/HI/Hinglish
  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: { "api-subscription-key": config.SARVAM_API_KEY! },
    body: form,
  });
  if (!res.ok) throw new Error(`sarvam ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { transcript: string };
  if (!data.transcript?.trim()) throw new Error("sarvam returned empty transcript");
  return data.transcript.trim();
}

async function groq(audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", config.GROQ_STT_MODEL);
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { text: string };
  if (!data.text?.trim()) throw new Error("groq returned empty transcript");
  return data.text.trim();
}

async function whisper(audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { text: string };
  return data.text.trim();
}
