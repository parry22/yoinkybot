/**
 * The single LLM gateway. Every model call in the codebase routes through here.
 *
 * Deliberately simple: one model (GLM 5.2 via OpenRouter), retries with backoff,
 * a JSON-repair pass, per-user daily call cap, and cost logging to usage_events.
 * There is no tier routing and no multi-provider fallback chain — every request
 * hits the same model. The `tier` field on requests is kept as advisory metadata
 * (callsites and prompt definitions still set it) but no longer changes routing.
 * No other module may call a model provider directly.
 */
import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";
import { queryOne } from "../db/pool.js";

// Kept so existing callsites/prompt definitions compile unchanged; ignored by routing.
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

// Approximate $/1M tokens for margin visibility; update as pricing changes.
// OpenRouter list price for z-ai/glm-5.2 verified 2026-07-05: $0.54 in / $1.76 out.
const PRICE: Record<string, { in: number; out: number }> = {
  [config.MODEL_CHAT]: { in: 0.54, out: 1.76 },
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
 * hang the user's turn forever — abort and let the retry path decide. */
export const PROVIDER_TIMEOUT_MS = Number(process.env.LLM_PROVIDER_TIMEOUT_MS ?? 45_000);

/**
 * fetch with a hard timeout via AbortController. Throws on timeout (an aborted
 * request rejects), which the retry wrapper treats as retriable — so a stalled
 * provider yields to a retry instead of blocking indefinitely.
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

/** Single OpenRouter call to the configured chat model. `useJsonMode` is separate
 *  from `req.json` so the caller can retry WITHOUT response_format when a provider
 *  rejects it (OpenRouter routes GLM across providers, and not all accept
 *  response_format json_object — that 400 must degrade, not kill the turn). */
async function callModel(req: LlmRequest, useJsonMode: boolean): Promise<LlmResponse> {
  if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not configured");
  const ignore = config.OPENROUTER_PROVIDER_IGNORE.split(",").map((s) => s.trim()).filter(Boolean);
  const model = config.MODEL_CHAT;
  const res = await fetchWithTimeout(`${config.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://t.me/yoinkyybot",
      "X-Title": "Yoinky",
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0.2,
      ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(ignore.length ? { provider: { ignore } } : {}),
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
    model,
    cost: cost(model, tokensIn, tokensOut),
  });
  return { text, model };
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

  // JSON requests ask for response_format json_object first. If the routed
  // provider rejects it (a non-retriable 400 — happens because OpenRouter spreads
  // GLM across providers with uneven support), fall back to plain mode and lean
  // on the prompt's "respond with ONLY valid JSON" + extractJson. Without this,
  // provider roulette silently broke every structured call (the onboarding loop).
  let res: LlmResponse;
  try {
    res = await withRetries(() => callModel(req, req.json === true), 3);
  } catch (err) {
    if (req.json && err instanceof LlmHttpError && err.status === 400) {
      console.warn("response_format rejected by provider; retrying without json mode");
      res = await withRetries(() => callModel(req, false), 3);
    } else {
      throw err;
    }
  }

  if (req.json) {
    try {
      res.parsed = extractJson(res.text);
    } catch {
      // One corrective retry (plain mode): re-ask with the failure appended.
      const retry = await withRetries(() =>
        callModel({ ...req, user: `${req.user}\n\nYour previous reply was not valid JSON. Respond with ONLY valid JSON.` }, false),
      );
      retry.parsed = extractJson(retry.text);
      return retry;
    }
  }
  return res;
}
