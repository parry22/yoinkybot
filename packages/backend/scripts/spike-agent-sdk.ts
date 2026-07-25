/**
 * Phase 0 verification spike (agent-runtime migration, docs/INTERNAL §3n).
 *
 * STANDALONE — not wired into the app. It exists to settle, against a REAL
 * LiteLLM → OpenRouter → grok-4.5 path, whether the Claude Agent SDK is a viable
 * runtime for Yoinky's bounded loops. Nothing else in the migration starts until
 * this passes. If the multi-step tool loop (test 2) or parallel tool use (test 3)
 * fails, grok-4.5-through-LiteLLM is not viable as an SDK backend and the rest of
 * the migration is void — record that and stop.
 *
 * Run (against a deployed LiteLLM proxy):
 *   LITELLM_BASE_URL=http://litellm.railway.internal:4000 \
 *   LITELLM_API_KEY=sk-... \
 *   pnpm --filter @yoink/backend exec tsx scripts/spike-agent-sdk.ts
 *
 * On Railway:  railway run --service backend pnpm --filter @yoink/backend exec tsx scripts/spike-agent-sdk.ts
 *
 * It proves the 9 spec items and prints a PASS/FAIL table. Copy the results into
 * docs/INTERNAL §3n before building the adapter.
 */
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const BASE_URL = process.env.LITELLM_BASE_URL;
const API_KEY = process.env.LITELLM_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "yoinky-agent";
const FALLBACK = process.env.AGENT_FALLBACK_MODEL ?? "yoinky-agent-fallback";

if (!BASE_URL || !API_KEY) {
  console.error("Set LITELLM_BASE_URL and LITELLM_API_KEY (a virtual key) before running the spike.");
  process.exit(2);
}

/** SDK env. TS `env` REPLACES the inherited env, so spread process.env. Both auth
 *  vars are set by default; test 7 probes which one LiteLLM actually accepts. */
function sdkEnv(opts: { authVar?: "both" | "token" | "key" } = {}): Record<string, string> {
  const which = opts.authVar ?? "both";
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: BASE_URL!,
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CONFIG_DIR: "/tmp/yoinky-claude-spike",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "yoinky-spike",
  };
  delete base.ANTHROPIC_AUTH_TOKEN;
  delete base.ANTHROPIC_API_KEY;
  if (which === "both" || which === "token") base.ANTHROPIC_AUTH_TOKEN = API_KEY!;
  if (which === "both" || which === "key") base.ANTHROPIC_API_KEY = API_KEY!;
  return base;
}

const LOCKDOWN = {
  tools: [] as string[], // remove ALL built-ins from the model's context
  allowedTools: ["mcp__yoinky__*"],
  permissionMode: "dontAsk" as const,
  settingSources: [] as [],
  strictMcpConfig: true,
  skills: [] as [],
};

// ── Fake in-process MCP tools (mirror the real loops' tool shapes) ────────────
let searchCalls = 0;
let profileCalls = 0;
const searchMemory = tool(
  "search_memory",
  "Search the user's memory for prior takes. Returns short snippets.",
  { query: z.string().describe("what to search for") },
  async ({ query: q }) => {
    searchCalls++;
    // Nudge a SECOND tool call: the result references the profile, so a
    // well-behaved model should call get_profile next before answering.
    return {
      content: [
        {
          type: "text" as const,
          text: `Found 1 snippet for "${q}": "pricing should be simple". To ground the final answer, also fetch the user's stated niche via get_profile.`,
        },
      ],
    };
  },
);
const getProfile = tool(
  "get_profile",
  "Get the user's stated brand profile (niche, pillars).",
  {},
  async () => {
    profileCalls++;
    return { content: [{ type: "text" as const, text: "niche: B2B SaaS pricing; pillars: pricing, GTM." }] };
  },
);
const yoinky = createSdkMcpServer({ name: "yoinky", version: "0.0.1", tools: [searchMemory, getProfile] });

interface Res { name: string; pass: boolean; detail: string }
const results: Res[] = [];
const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/** Drain a query, returning the final result message + a captured step array
 *  (built the way the real adapter will: tool_use blocks + their results). */
async function drain(q: AsyncIterable<any>) {
  const steps: Array<{ tool: string; args: unknown }> = [];
  let result: any = null;
  let firstTokenMs: number | null = null;
  const start = Date.now();
  for await (const m of q) {
    if (firstTokenMs === null && (m.type === "assistant" || m.type === "stream_event")) {
      firstTokenMs = Date.now() - start;
    }
    if (m.type === "assistant") {
      for (const block of m.message?.content ?? []) {
        if (block.type === "tool_use") steps.push({ tool: block.name, args: block.input });
      }
    }
    if (m.type === "result") result = m;
  }
  return { result, steps, firstTokenMs, totalMs: Date.now() - start };
}

async function test1_basic() {
  try {
    const { result } = await drain(
      query({
        prompt: "Reply with exactly the word: pong",
        options: { model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), maxTurns: 2, ...LOCKDOWN, mcpServers: { yoinky } },
      }),
    );
    record("1 basic query", result?.subtype === "success", `subtype=${result?.subtype} result=${JSON.stringify(result?.result)?.slice(0, 80)}`);
  } catch (e) {
    record("1 basic query", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

async function test2_multiStepLoop() {
  searchCalls = 0; profileCalls = 0;
  try {
    const { result, steps } = await drain(
      query({
        prompt:
          "Use search_memory to find the user's take on pricing, then follow its instruction to also call get_profile, then give a one-sentence answer grounded in both.",
        options: { model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), maxTurns: 6, ...LOCKDOWN, mcpServers: { yoinky } },
      }),
    );
    const ok = result?.subtype === "success" && searchCalls >= 1 && profileCalls >= 1;
    record("2 multi-step tool loop (THE gate)", ok, `search=${searchCalls} profile=${profileCalls} steps=${steps.length} subtype=${result?.subtype}`);
  } catch (e) {
    record("2 multi-step tool loop (THE gate)", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

async function test3_parallelTools() {
  searchCalls = 0; profileCalls = 0;
  try {
    const { result, steps } = await drain(
      query({
        prompt: "In a SINGLE step, call BOTH search_memory (query 'pricing') and get_profile at once, then answer.",
        options: { model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), maxTurns: 6, ...LOCKDOWN, mcpServers: { yoinky } },
      }),
    );
    // "works or fails cleanly" — either a success (parallel handled) or a clean
    // non-crash result subtype is acceptable; a thrown error is the only fail.
    record("3 parallel tool use (works or clean)", result != null, `subtype=${result?.subtype} steps=${steps.length}`);
  } catch (e) {
    record("3 parallel tool use (works or clean)", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

async function test4_structuredOutput() {
  const schema = {
    type: "object",
    properties: { fires: { type: "boolean" }, reply: { type: "string" } },
    required: ["fires", "reply"],
    additionalProperties: false,
  };
  try {
    const { result } = await drain(
      query({
        prompt: "Decide fires=true and give a one-line reply about simple pricing.",
        options: {
          model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), maxTurns: 3, ...LOCKDOWN, mcpServers: { yoinky },
          outputFormat: { type: "json_schema", schema },
        },
      }),
    );
    const so = result?.structured_output;
    const ok = result?.subtype === "success" && so && typeof so.fires === "boolean" && typeof so.reply === "string";
    record("4 structured output (else use fallback plan)", !!ok, `subtype=${result?.subtype} structured_output=${JSON.stringify(so)?.slice(0, 120)}`);
  } catch (e) {
    record("4 structured output (else use fallback plan)", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

async function test5_preToolUseDeny() {
  let denied = false;
  try {
    const { result } = await drain(
      query({
        prompt: "Call get_profile, then answer.",
        options: {
          model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), maxTurns: 5, ...LOCKDOWN, mcpServers: { yoinky },
          hooks: {
            PreToolUse: [
              {
                // Matchers match the FULL tool name. In-process MCP tools are
                // namespaced `mcp__<server>__<tool>`, so a bare "get_profile"
                // never fires (that false negative is what the first spike run
                // reported).
                matcher: "mcp__yoinky__get_profile",
                hooks: [
                  async () => {
                    denied = true;
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason: "spike: get_profile is denied",
                      },
                    };
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    record("5 PreToolUse deny honored (anti-loop ledger)", denied, `hookFired=${denied} subtype=${result?.subtype}`);
  } catch (e) {
    record("5 PreToolUse deny honored (anti-loop ledger)", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

/** A cap can surface EITHER as a result message with an error subtype OR as a
 *  thrown error — the first spike run proved maxTurns throws rather than
 *  returning `subtype=error_max_turns`. Both count as "the cap terminated the
 *  loop"; what matters for the adapter is that it must handle the throw too.
 *  Run each cap independently so a throw in one doesn't skip the other. */
async function runCap(
  label: string,
  opts: { maxTurns: number; maxBudgetUsd?: number },
  expectSubtype: string,
  expectThrow: RegExp,
): Promise<{ ok: boolean; how: string }> {
  try {
    const { result } = await drain(
      query({
        prompt: "Keep calling search_memory over and over; never give a final answer.",
        options: { model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), ...opts, ...LOCKDOWN, mcpServers: { yoinky } },
      }),
    );
    if (result?.subtype === expectSubtype) return { ok: true, how: `${label}=result:${result.subtype}` };
    return { ok: false, how: `${label}=result:${result?.subtype ?? "none"}` };
  } catch (e) {
    const msg = String((e as Error).message);
    if (expectThrow.test(msg)) return { ok: true, how: `${label}=THREW (cap honored, adapter must catch)` };
    return { ok: false, how: `${label}=threw-unexpected:${msg.slice(0, 120)}` };
  }
}

async function test6_caps() {
  const turns = await runCap("maxTurns", { maxTurns: 1 }, "error_max_turns", /maximum number of turns/i);
  const budget = await runCap(
    "maxBudgetUsd",
    { maxTurns: 50, maxBudgetUsd: 0.001 },
    "error_max_budget_usd",
    /budget|max_budget/i,
  );
  record("6 maxTurns / maxBudgetUsd terminate", turns.ok && budget.ok, `${turns.how} · ${budget.how}`);
}

async function test7_authVar() {
  const outcomes: Record<string, string> = {};
  for (const authVar of ["token", "key"] as const) {
    try {
      const { result } = await drain(
        query({ prompt: "Reply: ok", options: { model: MODEL, env: sdkEnv({ authVar }), maxTurns: 1, ...LOCKDOWN, mcpServers: { yoinky } } }),
      );
      outcomes[authVar] = result?.subtype ?? "no-result";
    } catch (e) {
      outcomes[authVar] = `threw:${String((e as Error).message).slice(0, 60)}`;
    }
  }
  const anyOk = Object.values(outcomes).some((v) => v === "success");
  record("7 which auth var LiteLLM accepts", anyOk, `ANTHROPIC_AUTH_TOKEN=${outcomes.token} · ANTHROPIC_API_KEY=${outcomes.key}`);
}

async function test8and9_costLatency() {
  searchCalls = 0; profileCalls = 0;
  try {
    const { result, firstTokenMs, totalMs } = await drain(
      query({
        prompt: "Use search_memory then get_profile then answer in one sentence.",
        options: { model: MODEL, fallbackModel: FALLBACK, env: sdkEnv(), maxTurns: 6, ...LOCKDOWN, mcpServers: { yoinky } },
      }),
    );
    record(
      "8/9 usage + latency (cross-check vs LiteLLM spend log)",
      result != null,
      `usage=${JSON.stringify(result?.usage)?.slice(0, 160)} total_cost_usd=${result?.total_cost_usd} firstToken=${firstTokenMs}ms full3ToolLoop=${totalMs}ms`,
    );
    console.log("   modelUsage:", JSON.stringify(result?.modelUsage));
  } catch (e) {
    record("8/9 usage + latency", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

async function main() {
  console.log(`\n=== Agent SDK spike → ${BASE_URL} model=${MODEL} fallback=${FALLBACK} ===\n`);
  await test1_basic();
  await test2_multiStepLoop();
  await test3_parallelTools();
  await test4_structuredOutput();
  await test5_preToolUseDeny();
  await test6_caps();
  await test7_authVar();
  await test8and9_costLatency();

  const gateTests = results.filter((r) => r.name.startsWith("2") || r.name.startsWith("3"));
  const gateOk = gateTests.every((r) => r.pass);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  console.log(gateOk ? "GATE OK — multi-tool loop + parallel tool use viable. Proceed." : "GATE FAILED — do NOT proceed; grok-4.5-via-LiteLLM is not viable as an SDK backend.");
  process.exit(gateOk ? 0 : 1);
}

main().catch((e) => {
  console.error("spike crashed:", e);
  process.exit(1);
});
