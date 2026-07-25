import { z } from "zod";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { runToolLoop, type ToolLoopRequest, type ToolLoopStep } from "../llm/tool-loop.js";
import { MCP_SERVER_NAME, qualify, toolsFromSchema } from "./mcp-tools.js";
import { zodToJsonSchema } from "./json-schema.js";
import { acquireSlot, AgentCapacityError, sampleUsedMb } from "./capacity.js";

/**
 * The agent-runtime adapter (docs/INTERNAL §3n).
 *
 * `runAgentLoop(feature, req)` is a DROP-IN for `runToolLoop(req)` — same request
 * shape, same `{ output, steps }` result — that dispatches to either the bespoke
 * runner or the Claude Agent SDK based on that feature's `AGENT_RUNTIME_*` flag.
 * Callsites change one line and keep both runtimes available, so a bad flip is a
 * config change away from being undone rather than a revert.
 *
 * Three things Phase 0 proved, all load-bearing here:
 *
 * 1. CAPS THROW. `maxTurns`/`maxBudgetUsd` surface as a thrown Error, NOT as a
 *    result with `subtype=error_max_turns`. Code that only inspects
 *    `result.subtype` reads a correctly-capped run as an unhandled crash, so the
 *    drain below classifies the throw instead.
 * 2. HOOK MATCHERS NEED THE QUALIFIED NAME. In-process MCP tools are
 *    `mcp__yoinky__<tool>`; a bare name matches nothing and the PreToolUse hook
 *    never fires. That hook IS the anti-loop ledger, so a bare matcher would fail
 *    OPEN — the exact bug the first spike run hid.
 * 3. NEVER METER FROM THE SDK. Its `total_cost_usd` over-reports grok-4.5 by
 *    ~3.4× (it prices the unknown model `yoinky-agent` off an Anthropic default).
 *    Cost is logged for shape only; LiteLLM's spend log is the ledger.
 */

export type AgentFeature = "viral" | "trend_take" | "consistency" | "buyer" | "reply" | "chat";

const FLAG: Record<AgentFeature, () => "legacy" | "sdk"> = {
  viral: () => config.AGENT_RUNTIME_VIRAL,
  trend_take: () => config.AGENT_RUNTIME_TREND_TAKE,
  consistency: () => config.AGENT_RUNTIME_CONSISTENCY,
  buyer: () => config.AGENT_RUNTIME_BUYER,
  reply: () => config.AGENT_RUNTIME_REPLY,
  chat: () => config.AGENT_RUNTIME_CHAT,
};

/**
 * The prompts in src/prompts were written for the legacy JSON envelope, where a
 * tool call is `{"tool": {...}}` in the model's output. Under the SDK the tools
 * are real callable tools, so that instruction is not just redundant, it is
 * actively wrong — a model that emits an envelope makes zero tool calls and
 * returns a placeholder answer. Rather than fork every prompt, override the
 * protocol at the end of the system prompt, where it wins on recency.
 */
const PROTOCOL_OVERRIDE = `

--- RUNTIME OVERRIDE (native tool calling is active) ---
Ignore the JSON "tool" envelope described above. Do NOT include a "tool" key in
your output and do NOT write tool requests as JSON. The tools listed above are
exposed to you as real, directly callable tools — call them normally.
When you have finished gathering, your final message must be ONLY the result
object described above, with the "tool" key omitted entirely.`;

/** Everything that keeps the subprocess from inheriting the operator's own
 *  Claude Code setup. Without `settingSources: []` the SDK would read the host's
 *  settings/skills and behave differently on a laptop than on Railway. */
const LOCKDOWN = {
  tools: [] as string[], // strip ALL built-ins (no Bash/Read/Write in a product loop)
  permissionMode: "dontAsk" as const,
  settingSources: [] as [],
  strictMcpConfig: true,
  skills: [] as [],
};

/** TS `env` REPLACES the inherited environment, so spread process.env first. */
function sdkEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: config.LITELLM_BASE_URL,
    // Phase 0 test 7: LiteLLM accepts either. Set both so the bundled binary
    // finds whichever it prefers without us guessing per version.
    ANTHROPIC_AUTH_TOKEN: config.LITELLM_API_KEY ?? "",
    ANTHROPIC_API_KEY: config.LITELLM_API_KEY ?? "",
    ENABLE_TOOL_SEARCH: "false",
    // Keep per-run state out of $HOME so concurrent subprocesses cannot collide
    // over the same config dir.
    CLAUDE_CONFIG_DIR: "/tmp/yoinky-agent-sdk",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "yoinky",
  };
}

export interface AgentLoopResult<S extends z.ZodTypeAny> {
  output: z.infer<S>;
  steps: ToolLoopStep[];
  /** Which runner actually produced this, after any fallback. For trails/telemetry. */
  runtime: "legacy" | "sdk";
}

export async function runAgentLoop<S extends z.ZodTypeAny>(
  feature: AgentFeature,
  req: ToolLoopRequest<S>,
): Promise<AgentLoopResult<S>> {
  const mode = FLAG[feature]();
  if (mode === "legacy") {
    const r = await runToolLoop(req);
    return { ...r, runtime: "legacy" };
  }

  if (!config.LITELLM_BASE_URL || !config.LITELLM_API_KEY) {
    // Misconfiguration, not a runtime failure — say so precisely instead of
    // letting the SDK fail with an opaque connection error.
    const why = `agent-runtime [${feature}] sdk mode requires LITELLM_BASE_URL + LITELLM_API_KEY`;
    if (!config.AGENT_SDK_FALLBACK_TO_LEGACY) throw new Error(why);
    console.warn(`agent-runtime FALLBACK [${feature}] → legacy: ${why}`);
    const r = await runToolLoop(req);
    return { ...r, runtime: "legacy" };
  }

  try {
    return await runViaSdk(feature, req);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!config.AGENT_SDK_FALLBACK_TO_LEGACY) throw err;
    // Loud by design: a runtime downgrade must never be invisible in the logs.
    console.warn(
      `agent-runtime FALLBACK [${feature}] → legacy after sdk failure: ${reason.slice(0, 300)}`,
    );
    const r = await runToolLoop(req);
    return { ...r, runtime: "legacy" };
  }
}

async function runViaSdk<S extends z.ZodTypeAny>(
  feature: AgentFeature,
  req: ToolLoopRequest<S>,
): Promise<AgentLoopResult<S>> {
  const steps: ToolLoopStep[] = [];
  // The anti-loop ledger, preserved from the legacy runner: the same tool with
  // the same args twice in one run is refused. Under the SDK this is enforced in
  // a PreToolUse hook, because by the time a tool handler runs the call already
  // counted against the turn budget.
  const seen = new Set<string>();
  // Tool calls the hook has let through — the loop's real budget (see maxTurns).
  let approved = 0;

  const { tools, derived } = toolsFromSchema(req.toolSchema, req.executors, {
    onCall: (name, args, result) => {
      steps.push({ tool: name, args, result });
      if (process.env.LLM_DEBUG === "true" || process.env.LLM_DEBUG === "1") {
        console.log(`agent-runtime [${req.eventType}] ${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.slice(0, 160)}`);
      } else {
        console.log(`agent-runtime [${req.eventType}] ${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.length} chars`);
      }
    },
  });

  if (tools.length === 0) {
    throw new Error(`agent-runtime [${feature}] derived no tools from the feature's tool schema`);
  }

  const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools });

  const release = await acquireSlot(`${feature}:${req.eventType}`);
  const memBefore = sampleUsedMb();
  const started = Date.now();
  let peakMem = memBefore ?? 0;

  try {
    const stream = query({
      // The loop's first user message. The legacy runner re-rendered this each
      // iteration to inject accumulated notes; the SDK keeps its own conversation
      // state across turns, so notes are unnecessary — hence `[]`.
      prompt: req.renderUser([]),
      options: {
        model: config.AGENT_MODEL,
        fallbackModel: config.AGENT_FALLBACK_MODEL,
        env: sdkEnv(),
        systemPrompt: req.system + PROTOCOL_OVERRIDE,
        // The TOOL BUDGET is enforced in the PreToolUse hook below, not by
        // maxTurns — mirroring the legacy runner, where exhausting the budget
        // forces a final answer rather than killing the run. maxTurns is only a
        // runaway backstop, so it needs headroom: the model spends one turn per
        // tool call and needs at least one more to compose. Setting it to
        // maxToolCalls + 1 (the obvious choice) makes a loop that uses its full
        // budget die with "Reached maximum number of turns" instead of
        // answering — observed, not theorised.
        maxTurns: req.maxToolCalls + 3,
        maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
        ...LOCKDOWN,
        allowedTools: derived.map((d) => d.qualifiedName),
        mcpServers: { [MCP_SERVER_NAME]: server },
        outputFormat: { type: "json_schema", schema: zodToJsonSchema(req.outputSchema) },
        hooks: {
          PreToolUse: derived.map((d) => ({
            // Finding 2: the QUALIFIED name. A bare `d.name` never matches and
            // the ledger silently stops working.
            matcher: d.qualifiedName,
            hooks: [
              async (input: unknown) => {
                const { tool_name, tool_input } = (input ?? {}) as {
                  tool_name?: string;
                  tool_input?: Record<string, unknown>;
                };
                const deny = (reason: string) => ({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: reason,
                  },
                });

                // Budget first — this is the legacy runner's `forceFinal`, and it
                // must be a deny (which the model can recover from by answering)
                // rather than a turn-cap kill (which it cannot).
                if (approved >= req.maxToolCalls) {
                  return deny(
                    "No more tool calls are available this run. Give your final answer now with what you have.",
                  );
                }

                const key = JSON.stringify({ name: d.name, ...(tool_input ?? {}) });
                if (seen.has(key)) {
                  return deny(
                    `Repeat call to ${tool_name ?? d.name} with identical arguments. ` +
                      `Do not call it again — answer with what you already have.`,
                  );
                }
                seen.add(key);
                approved++;
                return {};
              },
            ],
          })),
        },
      },
    });

    let result: any = null;
    for await (const message of stream) {
      if (message.type === "result") result = message;
      const now = sampleUsedMb();
      if (now != null && now > peakMem) peakMem = now;
    }

    if (result == null) throw new Error(`agent-runtime [${feature}] stream ended with no result message`);
    if (result.subtype !== "success") {
      // Caps also *can* arrive here (Phase 0 saw them throw, but do not assume
      // one channel) — either way it is a non-success and the caller gets legacy.
      throw new Error(`agent-runtime [${feature}] result subtype=${result.subtype}`);
    }

    const raw = result.structured_output ?? parseLooseJson(result.result);
    if (raw == null) throw new Error(`agent-runtime [${feature}] no structured output to parse`);

    const memDelta = memBefore != null ? peakMem - memBefore : null;
    console.log(
      `agent-runtime [${req.eventType}] sdk ok — steps=${steps.length} ` +
        `ms=${Date.now() - started} memΔ=${memDelta == null ? "n/a" : `${memDelta}MB`} ` +
        // Logged for shape only. Finding 3: this number is NOT our cost of record.
        `sdkCostUsd(unreliable)=${result.total_cost_usd}`,
    );

    return { output: req.outputSchema.parse(raw), steps, runtime: "sdk" };
  } finally {
    release();
  }
}

/**
 * `outputFormat` should hand back `structured_output`, but if a model returns the
 * object as text instead we still want the run. Tolerates a ```json fence.
 */
function parseLooseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export { AgentCapacityError, qualify };
