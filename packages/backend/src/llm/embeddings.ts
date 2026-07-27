import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";
import { LlmHttpError, fetchWithTimeout } from "./gateway.js";

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
      // DashScope text-embedding-v4 list price. It was 0 as a placeholder, which
      // silently zeroed every embedding line in usage telemetry whenever the
      // Qwen fallback was the active provider — and embeddings run on EVERY
      // buyer lead and every performance read, so the under-report compounded.
      // Deliberately rounded UP: an over-estimate shows in the budget, an
      // under-estimate hides.
      costPer1M: 0.07,
    };
  }
  throw new Error("no embedding provider configured (set OPENAI_API_KEY or QWEN_API_KEY)");
}

// DashScope (Qwen) rejects any single request with more than 10 inputs. OpenAI
// allows far more, but 10 is small enough to cost nothing extra there either,
// so one limit covers both providers without branching on which is active.
const MAX_BATCH_SIZE = 10;

async function embedChunk(
  texts: string[],
  provider: EmbeddingProvider,
): Promise<{ embeddings: number[][]; promptTokens: number }> {
  const res = await fetchWithTimeout(`${provider.baseUrl}/embeddings`, {
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
  return {
    embeddings: data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
    promptTokens: data.usage?.prompt_tokens ?? 0,
  };
}

/** Embed a batch of texts. Order of results matches input order. */
export async function embed(texts: string[], userId: string | null): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = resolveProvider();
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) chunks.push(texts.slice(i, i + MAX_BATCH_SIZE));

  const results = await Promise.all(chunks.map((chunk) => embedChunk(chunk, provider)));
  const promptTokens = results.reduce((sum, r) => sum + r.promptTokens, 0);
  await recordUsage({
    userId,
    eventType: "embed",
    tokensIn: promptTokens,
    tokensOut: 0,
    model: provider.model,
    cost: (promptTokens * provider.costPer1M) / 1_000_000,
  });
  return results.flatMap((r) => r.embeddings);
}

export async function embedOne(text: string, userId: string | null): Promise<number[]> {
  const [v] = await embed([text], userId);
  if (!v) throw new Error("embedding API returned no vector");
  return v;
}
