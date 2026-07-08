/**
 * The single LLM gateway. Every model call in the codebase routes through here:
 * tier → model routing, retries with backoff, cost logging to usage_events.
 * No other module may call a model provider directly.
 */
import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";
import { queryOne } from "../db/pool.js";

export type Tier = "cheap" | "frontier";

export interface LlmRequest {
  userId: string | null;
  eventType: string; // extract | link | compose | consistency | voice | draft | macro | search
  tier: Tier;
  system: string;
  user: string;
  maxTokens?: number;
  /** When true, the prompt must instruct JSON output; the response is parsed and returned. */
  json?: boolean;
}

export interface LlmResponse {
  text: string;
  parsed?: unknown;
  model: string;
}

const FRONTIER_MODEL = "claude-sonnet-5";

// Approximate $/1M tokens for margin visibility; update as pricing changes.
// DashScope international list prices as of mid-2026 (approx — verify on the
// Model Studio pricing page when it matters): qwen-max $1.6/$6.4, qwen-turbo
// $0.05/$0.2, text-embedding-v4 ~$0.07 in.
const PRICE: Record<string, { in: number; out: number }> = {
  [FRONTIER_MODEL]: { in: 3, out: 15 },
  [config.KIMI_MODEL]: { in: 0.6, out: 2.5 },
  [config.EMBEDDING_MODEL]: { in: 0.13, out: 0 },
  [config.QWEN_MODEL_CHEAP]: { in: 0.05, out: 0.2 },
  [config.QWEN_MODEL_FRONTIER]: { in: 1.6, out: 6.4 },
  [config.QWEN_EMBEDDING_MODEL]: { in: 0.07, out: 0 },
};

function cost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICE[model] ?? { in: 0, out: 0 };
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable =
        err instanceof LlmHttpError ? err.status === 429 || err.status >= 500 : true;
      if (!retriable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 250));
    }
  }
  throw lastErr;
}

export class LlmHttpError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`LLM provider error ${status}: ${body.slice(0, 500)}`);
  }
}

async function callAnthropic(req: LlmRequest): Promise<LlmResponse> {
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: FRONTIER_MODEL,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }),
  });
  if (!res.ok) throw new LlmHttpError(res.status, await res.text());
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  await recordUsage({
    userId: req.userId,
    eventType: req.eventType,
    tokensIn: data.usage.input_tokens,
    tokensOut: data.usage.output_tokens,
    model: FRONTIER_MODEL,
    cost: cost(FRONTIER_MODEL, data.usage.input_tokens, data.usage.output_tokens),
  });
  return { text, model: FRONTIER_MODEL };
}

interface OpenAiCompatibleProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Shared caller for any OpenAI-chat-completions-shaped provider (Kimi, Qwen/DashScope, ...). */
async function callOpenAiCompatible(req: LlmRequest, provider: OpenAiCompatibleProvider): Promise<LlmResponse> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0.2,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
  });
  if (!res.ok) throw new LlmHttpError(res.status, await res.text());
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const text = data.choices[0]?.message.content ?? "";
  const tokensIn = data.usage?.prompt_tokens ?? 0;
  const tokensOut = data.usage?.completion_tokens ?? 0;
  await recordUsage({
    userId: req.userId,
    eventType: req.eventType,
    tokensIn,
    tokensOut,
    model: provider.model,
    cost: cost(provider.model, tokensIn, tokensOut),
  });
  return { text, model: provider.model };
}

/**
 * Per-tier provider resolution: prefer the dedicated provider for that tier
 * (Anthropic for frontier, Kimi for cheap); fall back to Qwen/DashScope for
 * whichever tier lacks a dedicated key, so the pipeline runs on one key.
 */
function resolveCall(tier: Tier): (req: LlmRequest) => Promise<LlmResponse> {
  if (tier === "frontier") {
    if (config.ANTHROPIC_API_KEY) return callAnthropic;
    if (config.QWEN_API_KEY) {
      return (req) =>
        callOpenAiCompatible(req, {
          baseUrl: config.QWEN_BASE_URL,
          apiKey: config.QWEN_API_KEY!,
          model: config.QWEN_MODEL_FRONTIER,
        });
    }
    throw new Error("no frontier-tier LLM configured (set ANTHROPIC_API_KEY or QWEN_API_KEY)");
  }
  if (config.KIMI_API_KEY) {
    return (req) =>
      callOpenAiCompatible(req, { baseUrl: config.KIMI_BASE_URL, apiKey: config.KIMI_API_KEY!, model: config.KIMI_MODEL });
  }
  if (config.QWEN_API_KEY) {
    return (req) =>
      callOpenAiCompatible(req, {
        baseUrl: config.QWEN_BASE_URL,
        apiKey: config.QWEN_API_KEY!,
        model: config.QWEN_MODEL_CHEAP,
      });
  }
  throw new Error("no cheap-tier LLM configured (set KIMI_API_KEY or QWEN_API_KEY)");
}

/** Extract the first JSON value from model output, tolerating code fences and prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in model output");
  return JSON.parse(candidate.slice(start).trim().replace(/```$/, ""));
}

/** Per-user daily model-call ceiling — command spam can't burn unmetered spend. */
const DAILY_CALL_CAP = Number(process.env.LLM_DAILY_CALL_CAP ?? 400);

export class LlmBudgetError extends Error {
  constructor() {
    super("Daily AI budget reached for this account — resets at midnight UTC. Anything urgent still works tomorrow.");
  }
}

async function underDailyCap(userId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM usage_events WHERE user_id = $1 AND at > date_trunc('day', now())`,
    [userId],
  );
  return Number(row?.n ?? 0) < DAILY_CALL_CAP;
}

export async function llmCall(req: LlmRequest): Promise<LlmResponse> {
  // System jobs (null userId) are exempt; per-user work is capped per day.
  if (req.userId && !(await underDailyCap(req.userId))) throw new LlmBudgetError();
  const call = resolveCall(req.tier);
  const res = await withRetries(() => call(req));
  if (req.json) {
    try {
      res.parsed = extractJson(res.text);
    } catch {
      // One corrective retry: re-ask with the failure appended.
      const retry = await withRetries(() =>
        call({ ...req, user: `${req.user}\n\nYour previous reply was not valid JSON. Respond with ONLY valid JSON.` }),
      );
      retry.parsed = extractJson(retry.text);
      return retry;
    }
  }
  return res;
}
