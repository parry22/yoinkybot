/**
 * The single LLM gateway. Every model call in the codebase routes through here:
 * tier → model routing, retries with backoff, cost logging to usage_events.
 * No other module may call a model provider directly.
 */
import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";
import { queryOne } from "../db/pool.js";

export type Tier = "cheap" | "cheap_floor" | "frontier";

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

/**
 * Quality-critical one-shot artifacts: if the frontier model is down, queue and
 * retry (the pg-boss job re-runs) rather than silently completing a diagnosis
 * or voice profile on the fallback model. Everything else on the frontier list
 * degrades to the cheap-primary without ceremony.
 */
const NO_SILENT_DOWNGRADE = new Set(["diagnosis", "voice"]);

// Approximate $/1M tokens for margin visibility; update as pricing changes.
// OpenRouter list prices verified 2026-07-05: sonnet-5 $2/$10, glm-5.2
// $0.54/$1.76, deepseek-v4-flash $0.09/$0.18. DashScope (legacy floor):
// qwen-max $1.6/$6.4, qwen-turbo $0.05/$0.2, text-embedding-v4 ~$0.07 in.
const PRICE: Record<string, { in: number; out: number }> = {
  [FRONTIER_MODEL]: { in: 3, out: 15 },
  [config.MODEL_FRONTIER]: { in: 2, out: 10 },
  [config.MODEL_CHEAP_PRIMARY]: { in: 0.54, out: 1.76 },
  [config.MODEL_CHEAP_FLOOR]: { in: 0.09, out: 0.18 },
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

/** Default ceiling on any single provider HTTP call. A hung connection must not
 * hang the user's turn forever — abort and let the retry/fallback path decide. */
export const PROVIDER_TIMEOUT_MS = Number(process.env.LLM_PROVIDER_TIMEOUT_MS ?? 45_000);

/**
 * fetch with a hard timeout via AbortController. Throws on timeout (an aborted
 * request rejects), which the retry wrapper treats as retriable — so a stalled
 * provider yields to the next chain link instead of blocking indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`provider request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(req: LlmRequest): Promise<LlmResponse> {
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
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
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

/** Shared caller for any OpenAI-chat-completions-shaped provider (OpenRouter, Kimi, Qwen, ...). */
async function callOpenAiCompatible(req: LlmRequest, provider: OpenAiCompatibleProvider): Promise<LlmResponse> {
  const res = await fetchWithTimeout(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
      ...(provider.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0.2,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(provider.extraBody ?? {}),
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

/** An OpenRouter link in a fallback chain. */
function openRouter(model: string): (req: LlmRequest) => Promise<LlmResponse> {
  const ignore = config.OPENROUTER_PROVIDER_IGNORE.split(",").map((s) => s.trim()).filter(Boolean);
  return (req) =>
    callOpenAiCompatible(req, {
      baseUrl: config.OPENROUTER_BASE_URL,
      apiKey: config.OPENROUTER_API_KEY!,
      model,
      extraBody: ignore.length ? { provider: { ignore } } : undefined,
      extraHeaders: { "HTTP-Referer": "https://t.me/yoinkyybot", "X-Title": "Yoinky" },
    });
}

/**
 * Per-tier fallback chains (links tried in order, each with its own retries):
 *   frontier:    sonnet-5 → glm-5.2 → legacy — EXCEPT diagnosis/voice, which
 *                stop after sonnet-5 and let the job queue retry instead of
 *                silently completing on a lesser model.
 *   cheap:       glm-5.2 → deepseek-v4-flash → legacy
 *   cheap_floor: deepseek-v4-flash → glm-5.2 → legacy
 * Legacy direct providers (Anthropic/Kimi/Qwen) remain the floor so the
 * pipeline still runs if OPENROUTER_API_KEY is unset or OpenRouter is down.
 */
function resolveChain(tier: Tier, eventType: string): Array<(req: LlmRequest) => Promise<LlmResponse>> {
  const chain: Array<(req: LlmRequest) => Promise<LlmResponse>> = [];
  const or = !!config.OPENROUTER_API_KEY;

  if (tier === "frontier") {
    if (or) {
      chain.push(openRouter(config.MODEL_FRONTIER));
      if (!NO_SILENT_DOWNGRADE.has(eventType)) chain.push(openRouter(config.MODEL_CHEAP_PRIMARY));
    }
    if (config.ANTHROPIC_API_KEY) chain.push(callAnthropic);
    if (!or || !NO_SILENT_DOWNGRADE.has(eventType)) {
      if (config.QWEN_API_KEY) {
        chain.push((req) =>
          callOpenAiCompatible(req, {
            baseUrl: config.QWEN_BASE_URL,
            apiKey: config.QWEN_API_KEY!,
            model: config.QWEN_MODEL_FRONTIER,
          }),
        );
      }
    }
  } else {
    const [first, second] =
      tier === "cheap_floor"
        ? [config.MODEL_CHEAP_FLOOR, config.MODEL_CHEAP_PRIMARY]
        : [config.MODEL_CHEAP_PRIMARY, config.MODEL_CHEAP_FLOOR];
    if (or) chain.push(openRouter(first), openRouter(second));
    if (config.KIMI_API_KEY) {
      chain.push((req) =>
        callOpenAiCompatible(req, { baseUrl: config.KIMI_BASE_URL, apiKey: config.KIMI_API_KEY!, model: config.KIMI_MODEL }),
      );
    }
    if (config.QWEN_API_KEY) {
      chain.push((req) =>
        callOpenAiCompatible(req, {
          baseUrl: config.QWEN_BASE_URL,
          apiKey: config.QWEN_API_KEY!,
          model: config.QWEN_MODEL_CHEAP,
        }),
      );
    }
  }

  if (chain.length === 0) throw new Error(`no ${tier}-tier LLM configured (set OPENROUTER_API_KEY)`);
  return chain;
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

// Mechanical, ingest-driven calls are exempt from the interactive cap: a single
// /connect fans out into hundreds of embed/extract/link calls, and counting
// those would burn a user's whole day-one budget before their first /draft. The
// cap exists to bound interactive command spam, not honest onboarding.
const CAP_EXEMPT_EVENTS = ["embed", "link", "extract", "stt"];

async function underDailyCap(userId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM usage_events
     WHERE user_id = $1 AND at > date_trunc('day', now())
       AND event_type <> ALL($2)`,
    [userId, CAP_EXEMPT_EVENTS],
  );
  return Number(row?.n ?? 0) < DAILY_CALL_CAP;
}

export async function llmCall(req: LlmRequest): Promise<LlmResponse> {
  // System jobs (null userId) are exempt; per-user work is capped per day.
  if (req.userId && !(await underDailyCap(req.userId))) throw new LlmBudgetError();

  // Walk the tier's fallback chain: each link gets its own (short) retry pass;
  // a link that keeps failing yields to the next. Exhausting the chain throws,
  // which for job-driven work means "queue for retry" via pg-boss.
  const chain = resolveChain(req.tier, req.eventType);
  let res: LlmResponse | undefined;
  let call: ((r: LlmRequest) => Promise<LlmResponse>) | undefined;
  let lastErr: unknown;
  for (const link of chain) {
    try {
      res = await withRetries(() => link(req), 2);
      call = link;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`llm chain link failed (${req.tier}/${req.eventType}), trying next`, err instanceof Error ? err.message : err);
    }
  }
  if (!res || !call) throw lastErr ?? new Error("all llm chain links failed");

  if (req.json) {
    try {
      res.parsed = extractJson(res.text);
    } catch {
      // One corrective retry on the link that answered: re-ask with the failure appended.
      const retry = await withRetries(() =>
        call!({ ...req, user: `${req.user}\n\nYour previous reply was not valid JSON. Respond with ONLY valid JSON.` }),
      );
      retry.parsed = extractJson(retry.text);
      return retry;
    }
  }
  return res;
}
