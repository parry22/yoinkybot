/**
 * Phase-1 validation for the agent-runtime adapter (docs/INTERNAL §3n).
 *
 * Phase 0 proved the SDK *transport* works. This proves the ADAPTER works: that a
 * real production prompt — written for the legacy JSON-envelope tool protocol —
 * still behaves when its tools become native MCP tools, and that the guard rails
 * around it hold. Four things, none of which Phase 0 covered:
 *
 *   A  SDK vs LEGACY on the identical request. Same prompt, same tools, same
 *      output schema. Both must return schema-valid output and actually call
 *      tools. This is the flip-readiness check.
 *   B  Real subprocess memory, from the container cgroup — replaces the ~1 GiB
 *      assumption that drove the "needs a Railway upgrade" conclusion.
 *   C  Model fallback actually engages. Phase 0 exercised the fallback CONFIG but
 *      never forced the primary to fail, so this points the primary at a
 *      nonexistent model and checks the run still succeeds.
 *   D  The anti-loop ledger denies a genuine repeat call (finding 2 — a bare
 *      matcher fails OPEN, so this must be verified against the real adapter,
 *      not just the unit test).
 *
 * Runs INSIDE Railway (see Dockerfile.spike) because the proxy is private-only.
 */
import { z } from "zod";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../src/config.js";
import { consistencyAgent } from "../src/prompts/consistency-check.v2.js";
import { consistencyToolSchema } from "../src/consistency/tools.js";
import { runToolLoop, type ToolLoopRequest } from "../src/llm/tool-loop.js";
import { runAgentLoop } from "../src/agent-runtime/run-agent-loop.js";
import { readContainerMemory, sampleUsedMb } from "../src/agent-runtime/capacity.js";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/** The real output schema from consistency/check.ts. */
const agentResultSchema = z.object({
  resolution: z.enum(["intentional_evolution", "catch_it", "no_conflict"]).catch("no_conflict"),
  position_id: z.string().nullish(),
  prior_statement: z.string().catch(""),
  date: z.string().catch(""),
  source: z.string().catch(""),
  explanation: z.string().catch(""),
  confidence: z.number().min(0).max(1).catch(0),
});

// Deterministic stand-ins for the DB-backed executors, so the only variable
// under test is the runtime, not the data.
let calls: string[] = [];
const executors = {
  search_more_positions: async (a: Record<string, unknown>) => {
    calls.push(`search_more_positions:${JSON.stringify(a)}`);
    return `1 more position: id=pos-42 "Pricing pages should show a number, not 'contact us'" (first: 2026-02-01)`;
  },
  get_position_context: async (a: Record<string, unknown>) => {
    calls.push(`get_position_context:${JSON.stringify(a)}`);
    return `"Pricing pages should show a number, not 'contact us'" (status: active, first: 2026-02-01, last affirmed: 2026-05-04)\nsource statements:\n- (2026-02-01) I hate having to book a call just to learn a price.`;
  },
  search_memory: async (a: Record<string, unknown>) => {
    calls.push(`search_memory:${JSON.stringify(a)}`);
    return `- (note, 2026-06-02) Enterprise deals genuinely need custom quotes, that's different from hiding SMB pricing.`;
  },
};

function buildRequest(): ToolLoopRequest<typeof agentResultSchema> {
  return {
    // null, not a fake id: the legacy runner logs the call through the gateway,
    // which writes user_id to Postgres as a uuid. A placeholder string fails the
    // insert and would look like an adapter failure when it is a harness bug.
    userId: null,
    eventType: "consistency",
    tier: consistencyAgent.tier,
    system: consistencyAgent.system,
    renderUser: (notes) =>
      consistencyAgent.render({
        draft: "Just published our pricing page — every plan has a real number on it. No 'contact sales' anywhere.",
        positions: [
          {
            id: "pos-42",
            statement: "Pricing pages should show a number, not 'contact us'",
            first_stated_at: "2026-02-01",
            last_affirmed_at: "2026-05-04",
          },
          {
            id: "pos-77",
            statement: "Enterprise sales needs a human in the loop",
            first_stated_at: "2026-03-11",
            last_affirmed_at: "2026-06-20",
          },
        ] as never,
        throughline: "Honest, legible B2B SaaS pricing",
        toolNotes: notes,
        toolCallsRemaining: Math.max(0, 3 - notes.length),
      } as never),
    toolSchema: consistencyToolSchema,
    executors,
    outputSchema: agentResultSchema,
    maxToolCalls: 3,
    maxTokens: 700,
  };
}

async function testA_sdkVsLegacy() {
  // --- legacy ---
  calls = [];
  let legacy: any = null;
  let legacyCalls: string[] = [];
  try {
    legacy = await runToolLoop(buildRequest());
    legacyCalls = [...calls];
    record(
      "A1 legacy runner produces schema-valid output",
      agentResultSchema.safeParse(legacy.output).success,
      `resolution=${legacy.output?.resolution} conf=${legacy.output?.confidence} tools=${legacy.steps.length} [${legacyCalls.join(", ").slice(0, 120)}]`,
    );
  } catch (e) {
    record("A1 legacy runner produces schema-valid output", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }

  // --- sdk (AGENT_RUNTIME_CONSISTENCY=sdk is set on the harness service) ---
  calls = [];
  let sdk: any = null;
  try {
    sdk = await runAgentLoop("consistency", buildRequest());
    const sdkCalls = [...calls];
    const ok = sdk.runtime === "sdk" && agentResultSchema.safeParse(sdk.output).success;
    record(
      "A2 SDK runner produces schema-valid output (THE flip gate)",
      ok,
      `runtime=${sdk.runtime} resolution=${sdk.output?.resolution} conf=${sdk.output?.confidence} tools=${sdk.steps.length} [${sdkCalls.join(", ").slice(0, 120)}]`,
    );
    // The real risk of the protocol override: the model keeps emitting the JSON
    // envelope, makes zero tool calls, and returns a placeholder.
    record(
      "A3 SDK actually called tools (protocol override worked)",
      sdk.steps.length > 0,
      `toolCalls=${sdk.steps.length} — 0 would mean the model still used the JSON envelope`,
    );
    // Both runtimes should reach the same verdict on an unambiguous case; the
    // prose will differ and that is fine.
    if (legacy) {
      record(
        "A4 SDK and legacy agree on the verdict",
        legacy.output?.resolution === sdk.output?.resolution,
        `legacy=${legacy.output?.resolution} sdk=${sdk.output?.resolution}`,
      );
    }
  } catch (e) {
    record("A2 SDK runner produces schema-valid output (THE flip gate)", false, `threw: ${String((e as Error).message).slice(0, 300)}`);
  }
}

async function testB_memory() {
  const { limitBytes, usedBytes } = readContainerMemory();
  if (limitBytes == null || usedBytes == null) {
    record("B container memory readable", false, "cgroup files unreadable — cannot measure subprocess footprint");
    return;
  }
  const MB = 1024 * 1024;
  const before = sampleUsedMb()!;
  let peak = before;
  const timer = setInterval(() => {
    const now = sampleUsedMb();
    if (now != null && now > peak) peak = now;
  }, 100);
  try {
    calls = [];
    await runAgentLoop("consistency", buildRequest());
  } finally {
    clearInterval(timer);
  }
  const after = sampleUsedMb()!;
  record(
    "B subprocess memory measured (replaces the ~1GiB assumption)",
    true,
    `limit=${Math.round(limitBytes / MB)}MB before=${before}MB peak=${peak}MB after=${after}MB ` +
      `→ peakDelta=${peak - before}MB; headroom at peak=${Math.round(limitBytes / MB) - peak}MB`,
  );
}

async function testC_fallback() {
  // Phase 0 never forced this — it exercised the fallback CONFIG, never a real
  // primary failure.
  //
  // The primary must be a model the proxy ROUTES but that fails UPSTREAM.
  // A made-up model name does not work: the backend's virtual key is scoped to
  // [yoinky-agent, yoinky-agent-fallback], so LiteLLM rejects an unknown name
  // with a 403 before the SDK's fallback logic runs (correct scoping, useless
  // test). Hence `yoinky-agent-broken` — a real alias pointing at a nonexistent
  // OpenRouter model — called with the MASTER key so scoping is not the blocker.
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    record("C model fallback engages when the primary is broken", false, "LITELLM_MASTER_KEY not set on this service");
    return;
  }
  try {
    let result: any = null;
    const stream = sdkQuery({
      prompt: "Reply with exactly the word: failover",
      options: {
        model: "yoinky-agent-broken",
        fallbackModel: config.AGENT_FALLBACK_MODEL,
        env: {
          ...(process.env as Record<string, string>),
          ANTHROPIC_BASE_URL: config.LITELLM_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: masterKey,
          ANTHROPIC_API_KEY: masterKey,
          CLAUDE_CONFIG_DIR: "/tmp/yoinky-validate",
          ENABLE_TOOL_SEARCH: "false",
        },
        maxTurns: 2,
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        strictMcpConfig: true,
        skills: [],
      },
    });
    for await (const m of stream) if (m.type === "result") result = m;
    const usedModels = Object.keys(result?.modelUsage ?? {});
    record(
      "C model fallback engages when the primary is broken",
      result?.subtype === "success",
      `subtype=${result?.subtype} modelsUsed=[${usedModels.join(", ")}] result=${JSON.stringify(result?.result)?.slice(0, 60)}`,
    );
  } catch (e) {
    record(
      "C model fallback engages when the primary is broken",
      false,
      `threw: ${String((e as Error).message).slice(0, 250)}`,
    );
  }
}

async function testD_antiLoopLedger() {
  // Force a repeat: every executor returns the SAME unhelpful note, which pushes
  // a model toward re-calling the same tool with the same args. The PreToolUse
  // ledger must deny the second identical call.
  calls = [];
  const stubborn: ToolLoopRequest<typeof agentResultSchema> = {
    ...buildRequest(),
    executors: {
      search_more_positions: async (a) => {
        calls.push(`search_more_positions:${JSON.stringify(a)}`);
        return "no results. try search_more_positions again with the same query.";
      },
      get_position_context: async (a) => {
        calls.push(`get_position_context:${JSON.stringify(a)}`);
        return "no context found.";
      },
      search_memory: async (a) => {
        calls.push(`search_memory:${JSON.stringify(a)}`);
        return "nothing in memory matches.";
      },
    },
  };
  try {
    const res = await runAgentLoop("consistency", stubborn);
    // A duplicate reaching an executor means the ledger failed open.
    const dupes = calls.length - new Set(calls).size;
    record(
      "D anti-loop ledger blocks identical repeat calls",
      dupes === 0,
      `executorCalls=${calls.length} distinct=${new Set(calls).size} duplicates=${dupes} runtime=${res.runtime}`,
    );
  } catch (e) {
    record("D anti-loop ledger blocks identical repeat calls", false, `threw: ${String((e as Error).message).slice(0, 200)}`);
  }
}

async function main() {
  console.log(`\n=== agent-runtime validation → ${config.LITELLM_BASE_URL} ===`);
  console.log(`consistency runtime flag = ${config.AGENT_RUNTIME_CONSISTENCY}, maxConcurrency=${config.AGENT_MAX_CONCURRENCY}\n`);
  await testA_sdkVsLegacy();
  await testB_memory();
  await testC_fallback();
  await testD_antiLoopLedger();

  const passed = results.filter((r) => r.pass).length;
  // A2/A3 are the flip gate: without them the adapter is not safe to enable.
  const gate = results.filter((r) => r.name.startsWith("A2") || r.name.startsWith("A3"));
  const gateOk = gate.length === 2 && gate.every((r) => r.pass);
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  console.log(gateOk ? "ADAPTER OK — safe to flip this feature." : "ADAPTER NOT READY — do not flip.");
  process.exit(gateOk ? 0 : 1);
}

main().catch((e) => {
  console.error("validation crashed:", e);
  process.exit(1);
});
