import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";
import { LlmHttpError } from "./gateway.js";

interface EmbeddingProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  costPer1M: number;
}

/** Prefer OpenAI; fall back to Qwen/DashScope (OpenAI-compatible embeddings endpoint). */
function resolveProvider(): EmbeddingProvider {
  if (config.OPENAI_API_KEY) {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: config.OPENAI_API_KEY,
      model: config.EMBEDDING_MODEL,
      costPer1M: 0.13,
    };
  }
  if (config.QWEN_API_KEY) {
    return {
      baseUrl: config.QWEN_BASE_URL,
      apiKey: config.QWEN_API_KEY,
      model: config.QWEN_EMBEDDING_MODEL,
      costPer1M: 0, // placeholder until DashScope pricing is confirmed
    };
  }
  throw new Error("no embedding provider configured (set OPENAI_API_KEY or QWEN_API_KEY)");
}

/** Embed a batch of texts. Order of results matches input order. */
export async function embed(texts: string[], userId: string | null): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = resolveProvider();
  const res = await fetch(`${provider.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      input: texts.map((t) => t.slice(0, 8000)),
      dimensions: config.EMBEDDING_DIMS,
      encoding_format: "float",
    }),
  });
  if (!res.ok) throw new LlmHttpError(res.status, await res.text());
  const data = (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
    usage?: { prompt_tokens: number };
  };
  await recordUsage({
    userId,
    eventType: "embed",
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: 0,
    model: provider.model,
    cost: ((data.usage?.prompt_tokens ?? 0) * provider.costPer1M) / 1_000_000,
  });
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedOne(text: string, userId: string | null): Promise<number[]> {
  const [v] = await embed([text], userId);
  if (!v) throw new Error("embedding API returned no vector");
  return v;
}
