import { z } from "zod";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { MCP_SERVER_NAME, toolsFromSchema, type Executor } from "./mcp-tools.js";
import { zodToJsonSchema } from "./json-schema.js";
import { acquireSlot, sampleUsedMb } from "./capacity.js";
import { LOCKDOWN, PROTOCOL_OVERRIDE, sdkEnv } from "./sdk-options.js";

/**
 * The chat brain on the Agent SDK (docs/INTERNAL §3n, §3a).
 *
 * WHY THIS IS NOT `runAgentLoop`. The five bounded loops are pure: tools return
 * text, nothing reaches the user until the loop produces its final object. The
 * chat turn is not - each tool call has a SIDE EFFECT mid-turn. `executeTool`
 * says a short beat to the user ("on it, checking that first"), runs the tool
 * through the same code path its slash command uses, persists both as assistant
 * turns, and returns a trace. A 3-tool turn is meant to appear in history as its
 * fragments, not one opaque blob. That shape does not fit
 * `ToolLoopRequest → { output, steps }`, so chat gets its own entry point rather
 * than a contorted one.
 *
 * THE BEAT. In the legacy loop this is trivial: the model returns `{reply, tool}`
 * together, so `reply` IS the beat. Under native tool calling the equivalent is
 * the assistant text emitted in the same message as the `tool_use` block.
 *
 * Getting the beat took two attempts, and the dead end is worth recording.
 *
 * The complete `assistant` message (text + tool_use together) is NO USE here.
 * The SDK dispatches the tool from inside its own processing, so our `for await`
 * cannot advance until the handler returns - a handler that waits for that
 * message deadlocks against itself. Measured: `withBeat=0`, plus a full timeout
 * of dead latency on every tool call. Do not reintroduce a wait here.
 *
 * `includePartialMessages` is the channel that works. Text deltas stream as the
 * model generates them, which is BEFORE the tool_use block is complete and
 * therefore before dispatch - so the consumer has already banked the text while
 * it was still free to pump. The handler then reads it without blocking.
 * Parallel tool calls in one message share the beat: the first consumes it, the
 * rest correctly get "" so the narration is said once, not once per tool. If no
 * text was generated the beat is empty and the executor simply skips narration
 * (it already guards on that). The final `reply` comes from the structured
 * output, so it can never duplicate a beat that was already said.
 */

/**
 * KNOWN LIMITATION - the beat does not survive this runtime, and that is why
 * AGENT_RUNTIME_CHAT should stay `legacy` for now.
 *
 * Three attempts, each ruling something out:
 *   1. Read a `pendingBeat` set from the complete `assistant` message → empty.
 *   2. Wait for that message with an epoch counter → still empty, and it
 *      deadlocks (the handler blocks the iterator it is waiting on), costing the
 *      full timeout per tool call. Do not reintroduce a wait.
 *   3. `includePartialMessages` + this explicit instruction → partial streaming
 *      demonstrably works (`toolBlocks=3` observed) but the text buffer is STILL
 *      empty: `toolCalls=2 withBeat=0`.
 *
 * So the beat is not lost in transit - it is never generated. The most likely
 * cause is `outputFormat: json_schema` below: enforcing structured output
 * constrains what the assistant may emit, which leaves no room for free-text
 * narration between tool calls. The untried remedy is to drop `outputFormat` for
 * chat and recover the final object with a loose JSON parse, trading structured
 * -output reliability for narration. That is a real trade and belongs in its own
 * change, not smuggled into the migration.
 *
 * Net effect if chat is flipped today: a multi-tool turn is SILENT until the
 * final reply, where legacy narrates each step. Functionally correct, worse UX.
 * The instruction below is kept because it costs nothing and would start working
 * the moment the constraint above is lifted.
 */
const BEAT_INSTRUCTION = `

Before each tool call, first write ONE short sentence saying what you are about
to do ("on it, checking that first"). The user sees that line while the tool
runs, so a silent tool call reads as the conversation freezing. Keep it to a
handful of words, in your normal voice, and never repeat it after the tool.`;

/**
 * The actual fix for the silence, given the model will not narrate: say it in
 * code. A tool call that produces no beat is not allowed to be silent - the
 * user sees one of these instead, phrased per tool so it reads as Yoinky doing
 * the specific thing rather than a generic "working…" spinner.
 *
 * Lowercase on purpose: this goes through the same casual-voice register as the
 * rest of the DM (see prompts/style.ts CASUAL_VOICE). The model's own beat is
 * still preferred when there is one, so this becomes dead weight the day the
 * structured-output constraint is lifted - which is the intended direction, not
 * a permanent substitute.
 */
const TOOL_BEATS: Record<string, string> = {
  draft_post: "on it, drafting that now",
  repurpose: "reworking it now",
  repurpose_x_post: "turning your X post into a LinkedIn version",
  search_memory: "checking what you've told me",
  find_trends: "seeing what's actually live on this",
  offer_angles: "working out a few ways to take this",
  check_draft: "checking that against your positions",
  show_plan: "pulling up your plan",
  show_positions: "pulling up your positions",
  show_status: "checking where things stand",
  refresh_diagnosis: "re-reading your brand, one sec",
  connect_account: "getting that connected",
  forget: "clearing that out",
  schedule_post: "getting that scheduled",
  correct_classification: "fixing how i read that one",
  clear_everything: "one sec",
};

/**
 * Never let a tool run silently. Model beat first, canned beat otherwise.
 *
 * `previous` guards the one way canned beats read worse than silence: two calls
 * to the same tool in one turn (different args - identical ones are refused by
 * the ledger) would otherwise say the same sentence twice in a row, which reads
 * like a stuck bot rather than a working one.
 */
export function beatFor(toolName: string, modelBeat: string, previous: string): string {
  const beat = modelBeat || TOOL_BEATS[toolName] || "on it, one sec";
  if (beat === previous) return "still on it";
  return beat;
}

/** What the chat brain must return once it stops calling tools. */
const chatOutputSchema = z.object({
  reply: z.string().default(""),
  capture: z.boolean().default(false),
  offer_angles: z.boolean().default(false),
});

export interface AgentChatTurnRequest {
  userId: string;
  system: string;
  /** Fully rendered user message. Tool notes are empty - the SDK holds the
   *  conversation state that the legacy loop rebuilt by re-rendering. */
  user: string;
  maxToolCalls: number;
  /** The feature's tool contract (chatToolSchema - a discriminated union). */
  toolSchema: z.ZodTypeAny;
  /** Delivers the beat, runs the tool, returns the trace. Same executor the
   *  legacy loop uses, so both runtimes share one tool code path. */
  executeTool: (tool: { name: string } & Record<string, unknown>, replyBeat: string) => Promise<string>;
}

export interface AgentChatTurnResult {
  reply: string;
  capture: boolean;
  offerAngles: boolean;
  /** Tools actually executed this turn - for the caller's logging/trail. */
  toolCalls: number;
}

export async function runAgentChatTurn(req: AgentChatTurnRequest): Promise<AgentChatTurnResult> {
  /** Text deltas seen since the last tool call - the next beat, in progress. */
  let textBuffer = "";
  let toolCalls = 0;
  let seenToolUseBlocks = 0;
  let lastBeat = "";
  const seen = new Set<string>();
  let approved = 0;

  /** Take the narration banked before this tool call. Never blocks - see the
   *  deadlock note above. */
  function claimBeat(): string {
    const beat = textBuffer.trim();
    textBuffer = "";
    return beat;
  }

  // One synthetic executor per union member, all funnelling into the single
  // `executeTool` the chat layer already provides. Reusing toolsFromSchema means
  // adding a chat tool stays a one-line change to chatToolSchema, exactly as it
  // is today for the legacy path.
  const memberNames = unionToolNames(req.toolSchema);
  const executors: Record<string, Executor> = {};
  for (const name of memberNames) {
    executors[name] = async (args) => {
      // beatFor guarantees a non-empty beat, so a multi-tool turn is never
      // silent even though the model does not narrate under structured output.
      const beat = beatFor(name, claimBeat(), lastBeat);
      lastBeat = beat;
      toolCalls++;
      return req.executeTool({ name, ...args }, beat);
    };
  }

  const { tools, derived } = toolsFromSchema(req.toolSchema, executors);
  if (tools.length === 0) throw new Error("agent-runtime [chat] derived no tools from chatToolSchema");

  const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools });
  const release = await acquireSlot("chat");
  const memBefore = sampleUsedMb();
  const started = Date.now();

  try {
    const stream = query({
      prompt: req.user,
      options: {
        model: config.AGENT_MODEL,
        fallbackModel: config.AGENT_FALLBACK_MODEL,
        env: sdkEnv(),
        systemPrompt: req.system + PROTOCOL_OVERRIDE + BEAT_INSTRUCTION,
        // Budget lives in the hook (a deny the model can recover from), not in
        // maxTurns (a kill it cannot) - see run-agent-loop.ts for the incident.
        maxTurns: req.maxToolCalls + 3,
        maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
        // The ONLY channel that delivers the beat in time - see the note above.
        includePartialMessages: true,
        ...LOCKDOWN,
        allowedTools: derived.map((d) => d.qualifiedName),
        mcpServers: { [MCP_SERVER_NAME]: server },
        outputFormat: { type: "json_schema", schema: zodToJsonSchema(chatOutputSchema) },
        hooks: {
          PreToolUse: derived.map((d) => ({
            matcher: d.qualifiedName, // qualified, or the ledger fails open
            hooks: [
              async (input: unknown) => {
                const { tool_input } = (input ?? {}) as { tool_input?: Record<string, unknown> };
                const deny = (reason: string) => ({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: reason,
                  },
                });
                if (approved >= req.maxToolCalls) {
                  return deny("No more tool calls this turn. Give your final reply now.");
                }
                const key = JSON.stringify({ name: d.name, ...(tool_input ?? {}) });
                if (seen.has(key)) {
                  return deny(
                    `You already called ${d.name} with those exact arguments this turn - ` +
                      `answer with what you have.`,
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
      // Bank text as it streams, BEFORE any tool_use block is dispatched.
      if (message.type === "stream_event") {
        const ev = (message as any).event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          textBuffer += ev.delta.text ?? "";
        }
        // A new tool_use block starts: whatever text preceded it is that call's
        // beat and is left in textBuffer for the handler to claim.
        if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          seenToolUseBlocks++;
        }
      }
      // The final assistant message carries the reply, not a beat - drop any
      // trailing text so it cannot be said twice.
      if (message.type === "assistant") {
        const blocks = (message as any).message?.content ?? [];
        if (!blocks.some((b: any) => b.type === "tool_use")) textBuffer = "";
      }
      if (message.type === "result") result = message;
    }

    if (result == null) throw new Error("agent-runtime [chat] stream ended with no result message");
    if (result.subtype !== "success") throw new Error(`agent-runtime [chat] result subtype=${result.subtype}`);

    const parsed = chatOutputSchema.safeParse(result.structured_output ?? {});
    if (!parsed.success) throw new Error("agent-runtime [chat] output failed schema validation");

    const memDelta = memBefore != null ? (sampleUsedMb() ?? memBefore) - memBefore : null;
    console.log(
      `agent-runtime [converse] sdk ok - tools=${toolCalls} toolBlocks=${seenToolUseBlocks} ms=${Date.now() - started} ` +
        `memΔ=${memDelta == null ? "n/a" : `${memDelta}MB`}`,
    );

    return {
      reply: parsed.data.reply,
      capture: parsed.data.capture,
      offerAngles: parsed.data.offer_angles,
      toolCalls,
    };
  } finally {
    release();
  }
}

/** Tool names declared by a discriminated union's `name` literals. */
function unionToolNames(schema: z.ZodTypeAny): string[] {
  const d = (schema as unknown as { _def: Record<string, any> })._def ?? {};
  const options: z.ZodTypeAny[] = Array.isArray(d.options) ? d.options : [...(d.options?.values() ?? [])];
  const names: string[] = [];
  for (const opt of options) {
    const shape = (opt as unknown as { _def: Record<string, any> })._def?.shape?.() ?? {};
    const lit = shape.name?._def;
    if (lit?.typeName === "ZodLiteral") names.push(String(lit.value));
  }
  return names;
}
