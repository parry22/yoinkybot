/**
 * The single LLM gateway. Every model call in the codebase routes through here.
 *
 * Deliberately simple: one model (GLM 5.2 via OpenRouter), retries with backoff,
 * a bounded JSON recovery ladder (token-bump on truncation → repair-own-output
 * → truncation salvage), per-user daily call cap, and cost logging to usage_events.
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
  /** Provider finish reason ("stop" | "length" | …) — "length" means truncation. */
  finishReason?: string;
}

// Approximate $/1M tokens for margin visibility; update as pricing changes.
// OpenRouter list prices verified 2026-07-24 (x-ai/grok-4.5: $2 in / $6 out).
const PRICE: Record<string, { in: number; out: number }> = {
  "x-ai/grok-4.5": { in: 2.0, out: 6.0 },
  "z-ai/glm-5.2": { in: 0.54, out: 1.76 },
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
    choices: Array<{ message: { content?: string; reasoning?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const choice = data.choices[0];
  // GLM is a hybrid reasoning model: some providers put the whole answer in
  // message.reasoning and leave content empty — that used to surface as
  // "no JSON found in model output" on a call that actually answered.
  const content = choice?.message.content ?? "";
  const text = content.trim() ? content : (choice?.message.reasoning ?? "");
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
    if (req.json && err instanceof LlmHttpError && err.status === 400) {
      console.warn("response_format rejected by provider; retrying without json mode");
      res = await withRetries(() => callModel(req, false), 3);
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

    // ── The JSON recovery ladder (2026-07-13). GLM's JSON failures live in
    // three classes, each with its own rung; every rung is bounded. ──────────

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
