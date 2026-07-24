/**
 * The single LLM gateway. Every model call in the codebase routes through here.
 * No other module may call a model provider directly.
 *
 * One model (Grok 4.5), reached over one of two transports selected by
 * `LLM_TRANSPORT`: OpenRouter (default; cross-provider retry) or xAI-direct
 * (api.x.ai; unlocks the cache-affinity header, cached_tokens, reasoning_effort).
 * Also: retries with backoff, a bounded JSON recovery ladder, a per-user daily
 * call cap, and cost logging to usage_events.
 *
 * `tier` now maps to `reasoning_effort` (cheap→low, frontier→high, none→low) —
 * reasoning tokens bill at the output rate, so it's the biggest per-call lever.
 * `cacheKey` routes same-key requests to one upstream server so the prefix cache
 * is warm; the code is correct at a 0% hit rate — a warm cache is opportunistic.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { recordUsage } from "../usage/meter.js";
import { queryOne } from "../db/pool.js";

// "cheap_floor" is a legacy value some callsites still set; it maps like "cheap".
export type Tier = "none" | "cheap" | "cheap_floor" | "frontier";

export interface LlmRequest {
  userId: string | null;
  eventType: string; // extract | link | compose | consistency | voice | draft | macro | search
  tier: Tier;
  system: string;
  user: string;
  maxTokens?: number;
  /** When true, the prompt must instruct JSON output; the response is parsed and returned. */
  json?: boolean;
  /**
   * Native structured output (spec §5). When set alongside `json`, the request
   * uses constrained decoding (`response_format: json_schema`) instead of the
   * looser `json_object` mode — the model can't emit wrong-shape JSON. On a
   * provider that rejects it, the 400 degrade path drops it and the JSON recovery
   * ladder still runs, so this is a pure optimization: safe to attach anywhere.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /**
   * Cache-affinity routing tag (spec §3). Same key → same upstream server → warm
   * prefix cache. MUST NOT be a raw user id/email (it leaves our system as a
   * routing tag) — build it with `hashForCacheKey`. Optional; omitting it just
   * forgoes affinity, never breaks a call.
   */
  cacheKey?: string;
}

/** Map the advisory tier to a reasoning_effort. Reasoning tokens bill at the
 *  output rate, so lower effort is the largest single-call saving. "none" maps to
 *  "low" for now (grok-4.5 has no documented "off" switch); revisit if one lands. */
export function reasoningEffort(tier: Tier): "low" | "high" {
  return tier === "frontier" ? "high" : "low";
}

/** SHA-256 (first 16 hex chars) of an id, for use inside a cacheKey. Never send a
 *  raw user id to a third party as a routing tag. */
export function hashForCacheKey(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export interface LlmResponse {
  text: string;
  parsed?: unknown;
  model: string;
  /** Provider finish reason ("stop" | "length" | …) — "length" means truncation. */
  finishReason?: string;
}

// Approximate $/1M tokens for margin visibility. `cachedIn` = the discounted rate
// for prompt-cache hits (~4x cheaper on Grok 4.5). CONFIRM from the xAI/OpenRouter
// console before trusting — figures below checked 2026-07-24.
const PRICE: Record<string, { in: number; cachedIn: number; out: number }> = {
  "x-ai/grok-4.5": { in: 2.0, cachedIn: 0.5, out: 6.0 }, // OpenRouter id
  "grok-4.5": { in: 2.0, cachedIn: 0.5, out: 6.0 }, // xAI-direct id
  "z-ai/glm-5.2": { in: 0.54, cachedIn: 0.54, out: 1.76 }, // historical; no separate cached rate known
};

/** Price row for a model id, tolerant of the OpenRouter vs xAI naming split. */
function priceFor(model: string): { in: number; cachedIn: number; out: number } {
  if (PRICE[model]) return PRICE[model]!;
  if (model.includes("grok-4.5")) return PRICE["grok-4.5"]!;
  return { in: 0, cachedIn: 0, out: 0 };
}

/** Cost of one call. `cachedIn` tokens (a subset of `tokensIn`) bill at the
 *  discounted rate; the remaining fresh input at full rate; output (incl.
 *  reasoning) at the output rate. Exported for unit tests. */
export function cost(model: string, tokensIn: number, cachedIn: number, tokensOut: number): number {
  const p = priceFor(model);
  const fresh = Math.max(0, tokensIn - cachedIn);
  return (fresh * p.in + cachedIn * p.cachedIn + tokensOut * p.out) / 1_000_000;
}

/** Per-event count of JSON-recovery-ladder entries this process (spec §5 metric).
 *  A prompt that never enters under native structured output can drop its ladder. */
const ladderEntries = new Map<string, number>();
export function ladderEntryCounts(): Record<string, number> {
  return Object.fromEntries(ladderEntries);
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

/** Single chat-completions call over the active transport (OpenRouter or
 *  xAI-direct, per LLM_TRANSPORT). `useJsonMode` is separate from `req.json` so the
 *  caller can retry WITHOUT response_format when a provider rejects it (OpenRouter
 *  spreads across providers, and not all accept response_format — that 400 must
 *  degrade, not kill the turn). Both transports speak the OpenAI chat shape. */
async function callModel(req: LlmRequest, useJsonMode: boolean, sendReasoning = true): Promise<LlmResponse> {
  const xai = config.LLM_TRANSPORT === "xai";
  const apiKey = xai ? config.XAI_API_KEY : config.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error(`${xai ? "XAI_API_KEY" : "OPENROUTER_API_KEY"} not configured`);
  const baseUrl = xai ? config.XAI_BASE_URL : config.OPENROUTER_BASE_URL;
  const model = xai ? config.XAI_MODEL : config.MODEL_CHAT;
  const effort = reasoningEffort(req.tier);

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 1024,
    temperature: 0.2,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    // Native constrained decoding when a schema is supplied (spec §5), else the
    // looser json_object mode. Skipped entirely when useJsonMode is false (the
    // 400-degrade retry), so a provider that rejects response_format still runs.
    ...(useJsonMode
      ? {
          response_format: req.jsonSchema
            ? { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } }
            : { type: "json_object" },
        }
      : {}),
  };

  if (xai) {
    // xAI-native reasoning param + cache-affinity header (spec §3). NOTE: verify
    // grok-4.5 accepts reasoning_effort in the console before relying on it.
    if (sendReasoning) body.reasoning_effort = effort;
    if (req.cacheKey) headers["x-grok-conv-id"] = req.cacheKey;
  } else {
    headers["HTTP-Referer"] = "https://t.me/yoinkyybot";
    headers["X-Title"] = "Yoinky";
    // OpenRouter's unified reasoning param + its own sticky-routing tag (spec §1B).
    if (sendReasoning) body.reasoning = { effort };
    const ignore = config.OPENROUTER_PROVIDER_IGNORE.split(",").map((s) => s.trim()).filter(Boolean);
    if (ignore.length) body.provider = { ignore };
    if (req.cacheKey) body.session_id = req.cacheKey;
  }

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new LlmHttpError(res.status, await res.text());
  const data = (await res.json()) as {
    choices: Array<{ message: { content?: string; reasoning?: string }; finish_reason?: string }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cached_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  // Log the raw usage shape when debugging — the spec wants the live cached_tokens
  // location confirmed on the chosen transport before trusting the metering.
  if (process.env.LLM_DEBUG === "true" || process.env.LLM_DEBUG === "1") {
    console.log(`llm usage [${req.eventType}] transport=${xai ? "xai" : "openrouter"} ${JSON.stringify(data.usage ?? {})}`);
  }
  const choice = data.choices[0];
  // Hybrid reasoning models sometimes put the whole answer in message.reasoning
  // and leave content empty — that used to surface as "no JSON found".
  const content = choice?.message.content ?? "";
  const text = content.trim() ? content : (choice?.message.reasoning ?? "");
  const tokensIn = data.usage?.prompt_tokens ?? 0;
  const tokensOut = data.usage?.completion_tokens ?? 0;
  // cached_tokens is a SUBSET of prompt_tokens. Undefined (transport didn't report
  // it) → record NULL ("unknown"), not 0 (which would claim a cold cache). Cost
  // uses 0 when unknown, i.e. bills conservatively at the full input rate.
  const rawCached = data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.cached_tokens;
  const cachedIn = rawCached ?? 0;
  await recordUsage({
    userId: req.userId,
    eventType: req.eventType,
    tokensIn,
    tokensOut,
    cachedInputTokens: rawCached,
    model,
    cost: cost(model, tokensIn, cachedIn, tokensOut),
    reasoningEffort: effort,
  });
  return { text, model, finishReason: choice?.finish_reason };
}

/**
 * Walk a string starting at a `{` or `[` and return the balanced JSON slice —
 * i.e. up to the matching close bracket, string- and escape-aware. Returns the
 * whole rest when the structure never closes (truncated output); the caller's
 * parse then fails and the salvage path takes over.
 */
function balancedJsonSlice(s: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      if (inString) escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return s.slice(0, i + 1);
      }
    }
  }
  return s;
}

/** Drop trailing commas before } / ] — GLM emits them under JSON pressure. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Extract the first JSON value from model output, tolerating code fences
 * (including unterminated ones), leading prose, TRAILING prose after the value
 * ("{...} hope that helps" used to fail JSON.parse outright), and trailing
 * commas.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in model output");
  return JSON.parse(stripTrailingCommas(balancedJsonSlice(candidate.slice(start))));
}

/**
 * GLM's structured output occasionally wraps a single JSON object in an array
 * ([{...}]) or splits one object's fields across array elements
 * ([{"reply":...},{"tool":...}]). Callers that expect ONE object should run
 * res.parsed through this: an array of objects is shallow-merged back into a
 * single object, and anything else is returned untouched. This is valid-but-
 * wrong-shape JSON, so the recovery ladder above never catches it — without this
 * a purely structural quirk throws a raw Zod "expected object, received array"
 * and kills the whole turn (see telegram/conversation.ts).
 */
export function asObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    const objs = value.filter(
      (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v),
    );
    if (objs.length) return Object.assign({}, ...objs);
  }
  return value;
}

/**
 * Last-resort salvage for TRUNCATED JSON (finish_reason "length", mid-string
 * cutoffs): close the open string and brackets and parse; if the tail is
 * unparseably broken, chop back to the previous comma/close-bracket and try
 * again — so a cut-off array of N items degrades to the first N-1 items instead
 * of a hard failure. Returns undefined when nothing structured can be saved.
 * Only ever used after the model was ALREADY re-asked and failed again; a
 * partial parse of real output beats a dead job. Callers zod-validate.
 */
export function salvageTruncatedJson(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) return undefined;
  let s = candidate.slice(start);

  for (let attempt = 0; attempt < 50 && s.length > 1; attempt++) {
    // Rebuild the open-structure stack for the current prefix.
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (escaped) escaped = false;
      else if (ch === "\\") {
        if (inString) escaped = true;
      } else if (ch === '"') inString = !inString;
      else if (!inString) {
        if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") stack.pop();
      }
    }
    const closed = stripTrailingCommas(
      s + (inString ? '"' : "") + [...stack].reverse().join(""),
    );
    try {
      return JSON.parse(closed);
    } catch {
      // Drop the broken tail (e.g. a dangling `"key":`) and try one level back.
      const cut = Math.max(s.lastIndexOf(","), s.lastIndexOf("{"), s.lastIndexOf("["));
      if (cut <= 0) return undefined;
      s = s.slice(0, cut);
    }
  }
  return undefined;
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
    // A non-retriable 400 on the chat path is almost always a request param the
    // routed provider rejects — response_format (uneven across OpenRouter hosts)
    // or the reasoning field (unverified on grok-4.5). Degrade once: drop BOTH and
    // lean on the prompt's "respond with ONLY JSON" instruction. A plain call beats
    // a dead turn; without this, provider roulette (or an unaccepted param) would
    // silently break every structured call.
    if (err instanceof LlmHttpError && err.status === 400) {
      console.warn("provider rejected response_format/reasoning (400); retrying without them");
      res = await withRetries(() => callModel(req, false, false), 3);
    } else {
      throw err;
    }
  }

  if (req.json) {
    const tryParse = (r: LlmResponse): boolean => {
      try {
        r.parsed = extractJson(r.text);
        return true;
      } catch {
        return false;
      }
    };
    if (tryParse(res)) return res;

    // Ladder-entry metric (spec §5): first parse failed, so a recovery rung is
    // about to run (each rung re-charges input). Grep `json-ladder-entry` by
    // event to see which prompts still need it — a prompt that never enters it
    // under native structured output can drop its ladder; one that keeps entering
    // signals a too-tight max_tokens, not a flaky model.
    ladderEntries.set(req.eventType, (ladderEntries.get(req.eventType) ?? 0) + 1);
    console.warn(`json-ladder-entry event=${req.eventType} finish=${res.finishReason ?? "?"} schema=${req.jsonSchema ? "y" : "n"} count=${ladderEntries.get(req.eventType)}`);

    // ── The JSON recovery ladder (2026-07-13). Kept as a FALLBACK under native
    // structured outputs — three failure classes, each with its own bounded rung. ──

    // Rung 1 — truncation: finish_reason "length" means the JSON was cut off
    // mid-structure (GLM front-loads prose before the JSON, eating the budget).
    // Re-run the same call with a doubled token budget.
    const biggerBudget = Math.min(4096, (req.maxTokens ?? 1024) * 2);
    if (res.finishReason === "length") {
      const bigger = await withRetries(
        () => callModel({ ...req, maxTokens: biggerBudget }, req.json === true),
        2,
      ).catch(() => null);
      if (bigger) {
        if (tryParse(bigger)) return bigger;
        res = bigger; // newest text is the best input for the rungs below
      }
    }

    // Rung 2 — repair, not re-ask: hand the model its OWN previous output and
    // ask it to convert that to the required JSON. Much more reliable than
    // re-asking cold (the old corrective retry re-rolled the same dice and
    // failed live), and it preserves the answer that was already generated.
    const repair = await withRetries(
      () =>
        callModel(
          {
            ...req,
            // Reformatting the model's own text into JSON needs no deliberation —
            // force low reasoning_effort regardless of the original prompt's tier.
            tier: "none",
            maxTokens: biggerBudget,
            user:
              `${req.user}\n\nYou already answered this, but not as valid JSON. ` +
              `Convert YOUR PREVIOUS ANSWER below into the exact JSON format required above. ` +
              `Output ONLY the JSON — no prose, no code fences.\n\nYOUR PREVIOUS ANSWER:\n${res.text.slice(0, 6000)}`,
          },
          false,
        ),
      2,
    ).catch(() => null);
    if (repair && tryParse(repair)) return repair;

    // Rung 3 — salvage: best-effort close-and-parse of truncated structures,
    // newest text first. A partial parse of real output (fewer array items)
    // beats a dead job; callers zod-validate whatever comes out.
    for (const source of [repair, res]) {
      if (!source) continue;
      const salvaged = salvageTruncatedJson(source.text);
      if (salvaged !== undefined) {
        console.warn(`llm json salvage used for ${req.eventType} (finish=${source.finishReason ?? "?"})`);
        source.parsed = salvaged;
        return source;
      }
    }
    throw new Error(
      `no JSON found in model output after repair (event=${req.eventType}, finish=${res.finishReason ?? "?"})`,
    );
  }
  return res;
}
