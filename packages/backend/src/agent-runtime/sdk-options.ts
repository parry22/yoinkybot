import { config } from "../config.js";

/**
 * Options shared by every SDK entry point (the bounded loops in
 * run-agent-loop.ts and the chat turn in chat-turn.ts), kept in one place so a
 * lockdown or auth change cannot apply to one path and be forgotten on the other.
 */

/**
 * The prompts in src/prompts were written for the legacy JSON envelope, where a
 * tool call is `{"tool": {...}}` inside the model's output. Under the SDK the
 * tools are real callable tools, so that instruction is not merely redundant -
 * it is actively harmful: a model that emits an envelope makes zero tool calls
 * and returns a placeholder answer. Rather than fork every prompt, the protocol
 * is overridden at the END of the system prompt, where recency favours it.
 */
export const PROTOCOL_OVERRIDE = `

--- RUNTIME OVERRIDE (native tool calling is active) ---
Ignore the JSON "tool" envelope described above. Do NOT include a "tool" key in
your output and do NOT write tool requests as JSON. The tools listed above are
exposed to you as real, directly callable tools - call them normally.
When you have finished gathering, your final message must be ONLY the result
object described above, with the "tool" key omitted entirely.`;

/**
 * Strip the subprocess of everything that is not ours. Without
 * `settingSources: []` the SDK reads the host machine's Claude Code settings and
 * skills, so a loop would behave differently on a laptop than on Railway.
 */
export const LOCKDOWN = {
  tools: [] as string[], // remove ALL built-ins - no Bash/Read/Write in a product loop
  permissionMode: "dontAsk" as const,
  settingSources: [] as [],
  strictMcpConfig: true,
  skills: [] as [],
};

/** TS `env` REPLACES the inherited environment, so spread process.env first. */
export function sdkEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: config.LITELLM_BASE_URL,
    // Phase 0 test 7: LiteLLM accepts either variable. Set both so the bundled
    // binary finds whichever it prefers without us tracking that per version.
    ANTHROPIC_AUTH_TOKEN: config.LITELLM_API_KEY ?? "",
    ANTHROPIC_API_KEY: config.LITELLM_API_KEY ?? "",
    ENABLE_TOOL_SEARCH: "false",
    // Keep per-run state out of $HOME so concurrent subprocesses cannot collide
    // over one config dir.
    CLAUDE_CONFIG_DIR: "/tmp/yoinky-agent-sdk",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "yoinky",
  };
}

/** True when SDK mode is actually usable (proxy URL + scoped virtual key set). */
export function sdkConfigured(): boolean {
  return Boolean(config.LITELLM_BASE_URL && config.LITELLM_API_KEY);
}
