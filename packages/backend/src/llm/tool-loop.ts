import { z } from "zod";
import { llmCall, type Tier } from "./gateway.js";

/**
 * The shared bounded agent loop. Instead of one fixed-context call, the model
 * gets a small toolset and may make a few research calls before it must commit
 * to a final answer. The gates that decide WHETHER a loop runs at all stay in
 * deterministic code at the callsite — this runner never selects or scores,
 * it only lets the model gather grounding before composing.
 *
 * Hard rules, enforced here so no feature can drift into an open ReAct loop:
 * - `maxToolCalls` is a hard cap (features configure 2-4). Hitting it forces
 *   a final answer with what's been gathered.
 * - The same tool with the same args twice in one loop is rejected and forces
 *   a final answer (the anti-loop ledger pattern from the profiling intake).
 * - Every tool call + result is returned as `steps` and logged, so a loop is
 *   inspectable after the fact, never a black box.
 * - Every model call goes through llm/gateway.ts — no new call path.
 *
 * Envelope convention the prompt must follow: each response is JSON with an
 * optional "tool" key. `{"tool":{"name":"...",...args}}` requests a call;
 * `"tool": null` (or absent) means the rest of the object IS the final output.
 */

export interface ToolLoopStep {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface ToolLoopRequest<S extends z.ZodTypeAny> {
  userId: string | null;
  eventType: string;
  tier: Tier;
  system: string;
  /** Renders the user message; receives the accumulated tool notes so each
   *  iteration sees what the loop has already learned (compact notes, not raw
   *  payloads — the loop's own context stays lean). */
  renderUser: (toolNotes: string[]) => string;
  /** Validates a raw tool request from the model. Malformed → forces final. */
  toolSchema: z.ZodType<{ name: string }>;
  /** Executors by tool name. Each returns a compact text note for the model. */
  executors: Record<string, (args: Record<string, unknown>) => Promise<string>>;
  outputSchema: S;
  maxToolCalls: number;
  maxTokens?: number;
}

/** Truncation for the per-step note fed back into the loop's context. */
const NOTE_MAX_CHARS = 1200;

const envelopeSchema = z.object({ tool: z.unknown().nullish() }).passthrough();

export async function runToolLoop<S extends z.ZodTypeAny>(
  req: ToolLoopRequest<S>,
): Promise<{ output: z.infer<S>; steps: ToolLoopStep[] }> {
  const notes: string[] = [];
  const steps: ToolLoopStep[] = [];
  const seen = new Set<string>();
  let forceFinal = false;

  // maxToolCalls tool executions → at most maxToolCalls + 1 model calls.
  for (let call = 0; call <= req.maxToolCalls; call++) {
    const finalNote = forceFinal || call === req.maxToolCalls
      ? "\n\nNo more tool calls are available this run. Give your final answer now with what you have (tool must be null)."
      : "";
    const res = await llmCall({
      userId: req.userId,
      eventType: req.eventType,
      tier: req.tier,
      system: req.system,
      user: req.renderUser(notes) + finalNote,
      json: true,
      maxTokens: req.maxTokens ?? 1024,
    });
    const envelope = envelopeSchema.parse(res.parsed);

    const wantsTool = envelope.tool != null && !forceFinal && call < req.maxToolCalls;
    if (wantsTool) {
      const parsedTool = req.toolSchema.safeParse(envelope.tool);
      if (!parsedTool.success) {
        // Unknown/malformed tool → one more call, final answer only.
        notes.push("(your last tool request was invalid — answer with what you have)");
        forceFinal = true;
        continue;
      }
      const { name, ...args } = parsedTool.data as { name: string } & Record<string, unknown>;
      const key = JSON.stringify(parsedTool.data);
      const executor = req.executors[name];
      if (!executor || seen.has(key)) {
        notes.push(`(rejected repeat/unknown call to ${name} — answer with what you have)`);
        forceFinal = true;
        continue;
      }
      seen.add(key);
      let result: string;
      try {
        result = await executor(args);
      } catch (err) {
        result = `tool failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      steps.push({ tool: name, args, result });
      // The tool RESULT can contain private memory content (search_memory), so
      // it never goes to stdout unless LLM_DEBUG is on. The name + args are safe
      // and enough to trace the loop's shape in normal logs.
      if (process.env.LLM_DEBUG === "true" || process.env.LLM_DEBUG === "1") {
        console.log(`tool-loop [${req.eventType}] ${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.slice(0, 160)}`);
      } else {
        console.log(`tool-loop [${req.eventType}] ${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.length} chars`);
      }
      notes.push(`${name}(${JSON.stringify(args)}) → ${result.slice(0, NOTE_MAX_CHARS)}`);
      continue;
    }

    const { tool: _tool, ...rest } = envelope;
    return { output: req.outputSchema.parse(rest), steps };
  }
  throw new Error(`tool loop [${req.eventType}] ended without a final answer`);
}
