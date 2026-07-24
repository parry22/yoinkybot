# Claude Agent SDK Canonical Guide

Verified: 2026-05-20

This is a working source of truth for using the Claude Agent SDK to build custom agents with tools, MCP servers, subagents, sessions, permissions, hooks, streaming, structured output, and production controls.

The guide is based on the current official Claude Code Agent SDK documentation, the official demo repository, PyPI package metadata, and live package registry checks performed on 2026-05-20.

## Current Packages And Versions

| Ecosystem | Package | Install | Latest observed on 2026-05-20 |
| --- | --- | --- | --- |
| TypeScript/JavaScript | `@anthropic-ai/claude-agent-sdk` | `npm install @anthropic-ai/claude-agent-sdk` | `0.3.145` via `npm view` |
| Python | `claude-agent-sdk` | `pip install claude-agent-sdk` | `0.2.82` via PyPI / `pip index` |

Requirements:

- TypeScript SDK: Node.js 18+ or a compatible JS runtime.
- Python SDK: Python 3.10+.
- Authentication: set `ANTHROPIC_API_KEY`, or configure a supported provider.
- Both SDK packages currently bundle a native Claude Code binary. You usually do not install Claude Code separately.

Provider auth environment flags:

| Provider | Required SDK environment |
| --- | --- |
| Anthropic API | `ANTHROPIC_API_KEY=...` |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` plus AWS credentials |
| Claude Platform on AWS | `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`, `ANTHROPIC_AWS_WORKSPACE_ID`, plus AWS credentials |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` plus Google Cloud credentials |
| Microsoft Azure AI Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` plus Azure credentials |

Important commercial/auth note: the official docs say Agent SDK and `claude -p` subscription usage will start drawing from a separate monthly Agent SDK credit on 2026-06-15. For third-party products, use API-key/provider auth. Do not build products that offer end users claude.ai login or claude.ai subscription rate limits unless Anthropic has approved that arrangement.

## Mental Model

The Agent SDK is Claude Code as a programmable library.

The normal Anthropic client SDK gives you model calls and expects your application to implement the tool loop. The Agent SDK embeds the Claude Code loop: Claude reads context, chooses tools, the SDK executes tools, tool results go back to Claude, and the cycle continues until Claude returns a final answer.

Use the Agent SDK when you want agents that can:

- Read, edit, and write files.
- Run shell commands.
- Search code and the web.
- Use external systems through MCP.
- Call your in-process functions as custom tools.
- Maintain sessions and resume work.
- Spawn subagents.
- Enforce permissions, hooks, and sandbox rules.
- Stream text/tool progress to a UI.

Use the lower-level Anthropic client SDK when you need direct Messages API control and want to implement tool execution yourself.

Use Managed Agents when you want Anthropic-hosted agent infrastructure rather than running the agent loop, filesystem, session store, and sandbox yourself.

## Minimal Quickstart

### TypeScript

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "List the files in this project and summarize what it does.",
  options: {
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    maxTurns: 10,
  },
})) {
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log(message.result);
    } else {
      console.error(`Stopped: ${message.subtype}`);
    }
  }
}
```

### Python

```py
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


async def main():
    async for message in query(
        prompt="List the files in this project and summarize what it does.",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Glob", "Grep", "Bash"],
            max_turns=10,
        ),
    ):
        if isinstance(message, ResultMessage):
            if message.subtype == "success":
                print(message.result)
            else:
                print(f"Stopped: {message.subtype}")


asyncio.run(main())
```

## The Agent Loop

Every SDK run is a loop:

1. The SDK starts a session and emits an init/system message with session metadata.
2. Claude receives the prompt, system prompt, tools, settings, and session history.
3. Claude returns assistant content and possibly one or more tool calls.
4. The SDK evaluates permissions and hooks.
5. Approved tools execute.
6. Tool results are sent back to Claude as user/tool-result messages.
7. The loop repeats until Claude returns no tool calls.
8. The SDK emits a final result message with output, status, cost estimate, usage, turn count, and session ID.

A "turn" is a Claude response plus any tool execution and result feedback. `max_turns` / `maxTurns` limits tool-use turns. A final text-only response does not count the same way as a tool-use round trip.

Core result subtypes:

| Subtype | Meaning | Has final text result |
| --- | --- | --- |
| `success` | Claude completed normally | Yes |
| `error_max_turns` | Turn cap reached | No |
| `error_max_budget_usd` | Cost cap reached | No |
| `error_during_execution` | Execution/API/cancel error | No |
| `error_max_structured_output_retries` | Structured output validation failed repeatedly | No |

Always check the result subtype before reading `result`.

## Message Types

Python uses classes and `isinstance`. TypeScript uses a discriminating `type` field.

| Concept | Python | TypeScript | Notes |
| --- | --- | --- | --- |
| Session lifecycle | `SystemMessage` | `SDKSystemMessage` / compact boundary message | Init contains session metadata and available tools/commands. |
| Claude response | `AssistantMessage` | `SDKAssistantMessage` | May contain text, thinking, and `tool_use` blocks. |
| Tool/user feedback | `UserMessage` | `SDKUserMessage` | Includes tool results and streamed user input. |
| Raw streaming delta | `StreamEvent` | `type: "stream_event"` | Only when partial messages are enabled. |
| Final status | `ResultMessage` | `SDKResultMessage` | Has subtype, cost estimate, usage, session ID. |

TypeScript assistant/user content is under `message.message.content`. Python exposes content directly as `message.content`.

Do not stop iterating immediately after a `ResultMessage` unless you have intentionally closed the query. Some trailing status events can arrive after the result. For most scripts this is minor, but for robust consumers let the stream finish.

## API Surface

### TypeScript Functions

| Function | Purpose |
| --- | --- |
| `query({ prompt, options })` | Main entry point. Returns a `Query` async generator. |
| `startup({ options, initializeTimeoutMs })` | Pre-warms the Claude Code subprocess before a prompt is ready. Returns `WarmQuery`. |
| `tool(name, description, inputSchema, handler, extras?)` | Defines a typed in-process MCP tool using Zod schemas. |
| `createSdkMcpServer({ name, version, tools })` | Bundles SDK tools into an in-process MCP server. |
| `listSessions`, `getSessionMessages`, `getSessionInfo` | Read persisted sessions. |
| `renameSession`, `tagSession` | Organize sessions. |
| `resolveSettings` | Inspect resolved settings. |

The `Query` object is both an async generator and a control surface:

- `interrupt()`
- `rewindFiles(userMessageId, { dryRun? })`
- `setPermissionMode(mode)`
- `setModel(model?)`
- `setMaxThinkingTokens(...)` deprecated; use `thinking`
- `applyFlagSettings(settings)` TypeScript-only runtime settings override
- `initializationResult()`
- `supportedCommands()`
- `supportedModels()`
- `supportedAgents()`
- `mcpServerStatus()`
- `accountInfo()`
- `reconnectMcpServer(serverName)`
- `toggleMcpServer(serverName, enabled)`
- `setMcpServers(servers)`
- `streamInput(stream)`
- `stopTask(taskId)`
- `close()`

### Python Functions And Classes

| Surface | Purpose |
| --- | --- |
| `query(prompt=..., options=..., transport=...)` | One-off or resumable query, returns an async iterator. |
| `ClaudeSDKClient` | Session-oriented client for continuous conversations, interrupts, dynamic permission/model changes, MCP management, and file rewind. |
| `@tool(...)` | Decorator for defining in-process MCP tools. |
| `create_sdk_mcp_server(...)` | Bundles SDK tools into an in-process MCP server. |
| `list_sessions`, `get_session_messages`, `get_session_info` | Read persisted sessions. |
| `rename_session`, `tag_session` | Organize sessions. |

`ClaudeSDKClient` key methods:

- `connect(prompt=None)`
- `query(prompt, session_id="default")`
- `receive_messages()`
- `receive_response()`
- `interrupt()`
- `set_permission_mode(mode)`
- `set_model(model=None)`
- `rewind_files(user_message_id)`
- `get_mcp_status()`
- `reconnect_mcp_server(server_name)`
- `toggle_mcp_server(server_name, enabled)`
- `stop_task(task_id)`
- `get_server_info()`
- `disconnect()`

Prefer `query()` for one-shot work. Prefer `ClaudeSDKClient` for chat interfaces, streaming input, interrupts, and multi-turn state in one process.

## Key Options

Names differ by language:

| Concept | TypeScript | Python |
| --- | --- | --- |
| Current working directory | `cwd` | `cwd` |
| Extra accessible dirs | `additionalDirectories` | `add_dirs` |
| Auto-approve tools | `allowedTools` | `allowed_tools` |
| Deny/remove tools | `disallowedTools` | `disallowed_tools` |
| Tool availability | `tools` | `tools` |
| MCP servers | `mcpServers` | `mcp_servers` |
| Strict MCP config | `strictMcpConfig` | `strict_mcp_config` |
| Permission mode | `permissionMode` | `permission_mode` |
| Permission callback | `canUseTool` | `can_use_tool` |
| Hooks | `hooks` | `hooks` |
| System prompt | `systemPrompt` | `system_prompt` |
| Filesystem setting sources | `settingSources` | `setting_sources` |
| Continue latest session | `continue` | `continue_conversation` |
| Resume session ID | `resume` | `resume` |
| Fork resumed session | `forkSession` | `fork_session` |
| Max turns | `maxTurns` | `max_turns` |
| Cost cap | `maxBudgetUsd` | `max_budget_usd` |
| Model | `model` | `model` |
| Fallback model | `fallbackModel` | `fallback_model` |
| Effort | `effort` | `effort` |
| Thinking | `thinking` | `thinking` |
| Structured output | `outputFormat` | `output_format` |
| Partial stream events | `includePartialMessages` | `include_partial_messages` |
| Hook events in stream | `includeHookEvents` | `include_hook_events` |
| Subagents | `agents` | `agents` |
| Skills | `skills` | `skills` |
| Plugins | `plugins` | `plugins` |
| Sandbox | `sandbox` | `sandbox` |
| File checkpointing | `enableFileCheckpointing` | `enable_file_checkpointing` |
| External session store | `sessionStore` | `session_store` |

Important environment behavior:

- Python `env` is merged on top of the inherited environment.
- TypeScript `env` replaces the inherited environment. Use `{ ...process.env, YOUR_VAR: "value" }` unless you intentionally want a sparse environment.
- Set `CLAUDE_AGENT_SDK_CLIENT_APP` in `env` to identify your app in the User-Agent header.

## System Prompts

The current Agent SDK does not default to the full Claude Code system prompt. It uses a minimal tool-calling prompt unless you specify otherwise.

Starting points:

| Choice | Use when |
| --- | --- |
| Minimal default | You provide behavior in user prompts or custom system prompt. |
| `claude_code` preset | You are building a coding agent similar to Claude Code CLI or IDE behavior. |
| `claude_code` plus `append` | You want Claude Code behavior plus product/project instructions. |
| Custom string | Your agent has a different identity, UI, domain, or permission model. |

TypeScript:

```ts
const options = {
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "Always produce a short test plan before editing.",
    excludeDynamicSections: true,
  },
};
```

Python:

```py
options = ClaudeAgentOptions(
    system_prompt={
        "type": "preset",
        "preset": "claude_code",
        "append": "Always produce a short test plan before editing.",
        "exclude_dynamic_sections": True,
    }
)
```

`excludeDynamicSections` improves cross-machine prompt-cache reuse by moving dynamic environment details out of the system prompt and into the first user message. Use it when cache stability matters more than making environment details maximally authoritative.

Output styles:

- Stored as files under `~/.claude/output-styles/` or `.claude/output-styles/`.
- Loaded through setting sources.
- TypeScript selects them through `settings.outputStyle`, not top-level `outputStyle`.
- Python does not currently expose a direct programmatic output-style selector; use settings files, `append`, or custom prompts.

## Filesystem Settings And Claude Code Features

By default, omitting `settingSources` / `setting_sources` loads user, project, and local filesystem settings, matching Claude Code CLI behavior.

| Source | Loads |
| --- | --- |
| `project` | Project `CLAUDE.md`, `.claude/rules/*.md`, project skills, project hooks, project settings, project commands. |
| `user` | `~/.claude/CLAUDE.md`, user rules, user skills, user settings. |
| `local` | `CLAUDE.local.md`, `.claude/settings.local.json`. |

Omitting the option is equivalent to all three: `["user", "project", "local"]`.

For isolation, pass `settingSources: []` / `setting_sources=[]`, but know the exceptions:

- Managed policy settings still load.
- `~/.claude.json` global config is still read unless you relocate it with `CLAUDE_CONFIG_DIR`.
- Auto memory can still load unless disabled by settings or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

For multi-tenant deployments, use:

```ts
const options = {
  settingSources: [],
  env: {
    ...process.env,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: "/tmp/tenant-isolated-claude-config",
  },
};
```

Use `CLAUDE.md` when the same conventions should apply to CLI and SDK sessions. Use system prompt `append` when the instruction belongs to this application call. Use custom system prompts when the product is not Claude-Code-like.

## Built-In Tools

The SDK exposes Claude Code built-ins:

| Category | Tools |
| --- | --- |
| Files | `Read`, `Write`, `Edit`, `NotebookEdit` |
| Search | `Glob`, `Grep` |
| Execution | `Bash`, `Monitor`, `BashOutput`, `KillBash` |
| Web | `WebSearch`, `WebFetch` |
| Orchestration | `Agent`, `Skill`, `AskUserQuestion`, task/todo tools |
| MCP resources | `ListMcpResources`, `ReadMcpResource` |
| Planning | `ExitPlanMode` |

Tool availability and tool approval are different:

- `tools` controls which built-in tools are visible to Claude.
- `allowedTools` / `allowed_tools` pre-approves matching tool calls.
- `allowedTools` does not restrict the tool surface by itself.
- `disallowedTools` / `disallowed_tools` can remove bare tool names from context or deny scoped patterns.
- MCP tools are named `mcp__{server_name}__{tool_name}`.

Locked-down read-only pattern:

```ts
const options = {
  tools: ["Read", "Glob", "Grep", "AskUserQuestion"],
  allowedTools: ["Read", "Glob", "Grep", "AskUserQuestion"],
  permissionMode: "dontAsk",
};
```

Do not use `allowedTools: ["Read"]` with `permissionMode: "bypassPermissions"` expecting only Read to run. In bypass mode, unlisted tools that remain available can still be approved unless removed/denied separately.

## Custom Tools

Custom tools are in-process MCP tools. They are ordinary async functions with:

1. Name.
2. Description.
3. Input schema.
4. Handler that returns an MCP-style tool result.

### TypeScript Custom Tool

```ts
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const lookupCustomer = tool(
  "lookup_customer",
  "Look up a customer by email address.",
  {
    email: z.string().email().describe("Customer email address"),
  },
  async ({ email }) => {
    const customer = await fakeCustomerLookup(email);
    if (!customer) {
      return {
        content: [{ type: "text", text: `No customer found for ${email}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Found ${customer.name}` }],
      structuredContent: customer,
    };
  },
  { annotations: { readOnlyHint: true, openWorldHint: false } }
);

const crmServer = createSdkMcpServer({
  name: "crm",
  version: "1.0.0",
  tools: [lookupCustomer],
});

for await (const message of query({
  prompt: "Find the account status for ada@example.com",
  options: {
    mcpServers: { crm: crmServer },
    allowedTools: ["mcp__crm__lookup_customer"],
  },
})) {
  if (message.type === "result") console.log(message);
}
```

### Python Custom Tool

```py
import asyncio
from typing import Any
from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    create_sdk_mcp_server,
    query,
    tool,
)


@tool("lookup_customer", "Look up a customer by email address.", {"email": str})
async def lookup_customer(args: dict[str, Any]) -> dict[str, Any]:
    customer = await fake_customer_lookup(args["email"])
    if not customer:
        return {
            "content": [{"type": "text", "text": f"No customer found for {args['email']}"}],
            "is_error": True,
        }
    return {"content": [{"type": "text", "text": f"Found {customer['name']}"}]}


crm_server = create_sdk_mcp_server(
    name="crm",
    version="1.0.0",
    tools=[lookup_customer],
)


async def main():
    async for message in query(
        prompt="Find the account status for ada@example.com",
        options=ClaudeAgentOptions(
            mcp_servers={"crm": crm_server},
            allowed_tools=["mcp__crm__lookup_customer"],
        ),
    ):
        if isinstance(message, ResultMessage):
            print(message)


asyncio.run(main())
```

Custom tool return shape:

| Field | Required | Meaning |
| --- | --- | --- |
| `content` | Yes | Array of text, image, or resource blocks. |
| `isError` / `is_error` | No | Mark a failed tool result while keeping the agent loop alive. |
| `structuredContent` | No | Machine-readable JSON result. Current docs note Python in-process tools forward only `content` and `is_error`; use a standalone MCP server if you need Python `structuredContent`. |

Tool annotations:

| Annotation | Meaning |
| --- | --- |
| `readOnlyHint` | No side effects. Enables parallel calls where safe. |
| `destructiveHint` | May modify/delete data. Informational. |
| `idempotentHint` | Repeating same call has no added effect. Informational. |
| `openWorldHint` | Reaches outside the process/domain. Informational. |

Annotations are hints, not security controls. Make them truthful and enforce real policy elsewhere.

Tool result content types:

- Text: `{ type: "text", text: "..." }`
- Image: `{ type: "image", data: "base64...", mimeType: "image/png" }`
- Resource: `{ type: "resource", resource: { uri, text/blob, mimeType? } }`

For errors, catch inside the tool and return `isError` / `is_error`. Throwing an uncaught exception aborts the entire query and Claude does not get a chance to adapt.

## External MCP Servers

MCP connects agents to external tools and data sources.

Transport choices:

| Server docs give you | Use |
| --- | --- |
| A command to run | Stdio server |
| A URL | HTTP or SSE server |
| Your app function | SDK in-process MCP server |

TypeScript stdio example:

```ts
const options = {
  mcpServers: {
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    },
  },
  allowedTools: ["mcp__github__list_issues"],
};
```

HTTP example:

```ts
const options = {
  mcpServers: {
    docs: {
      type: "http",
      url: "https://code.claude.com/docs/mcp",
      headers: { Authorization: `Bearer ${process.env.DOCS_TOKEN}` },
    },
  },
  allowedTools: ["mcp__docs__*"],
};
```

`.mcp.json` example:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    }
  }
}
```

`.mcp.json` loads only when `project` setting sources are enabled. `strictMcpConfig: true` / `strict_mcp_config=True` tells the SDK to use only MCP servers supplied programmatically and ignore project/user/plugin MCP definitions.

Discover MCP connection status from the init/system message. Failed MCP servers usually mean missing env vars, missing packages, bad URLs, invalid connection strings, or connection timeouts.

MCP tools require explicit permission. Prefer `allowedTools: ["mcp__server__*"]` over broad `bypassPermissions`.

## Tool Search

Tool search is enabled by default. Instead of loading every MCP/custom tool schema into context, Claude sees a searchable catalog and loads the 3-5 most relevant tools on demand.

Use it when:

- You have dozens, hundreds, or thousands of tools.
- Tool schemas consume too much context.
- Claude's tool selection gets worse because too many tools are visible.

Environment control:

| `ENABLE_TOOL_SEARCH` | Behavior |
| --- | --- |
| unset | Enabled by default; may fall back to upfront loading on Vertex AI or non-first-party base URLs. |
| `true` | Force on. |
| `auto` | Enable when combined tool schemas exceed 10 percent of context. |
| `auto:N` | Custom threshold, such as `auto:5`. |
| `false` | Disable; load all tools upfront. |

Tool search requires Sonnet 4+ or Opus 4+. Haiku models do not support it. On small tool sets below roughly 10 tools, loading upfront can be faster.

Optimize search by giving tools specific names and descriptions:

- Better: `search_slack_messages` with "Search Slack messages by keyword, channel, or date range."
- Worse: `query` with "Query things."

## Permissions

Permission evaluation order:

1. Hooks run first.
2. Deny rules are checked.
3. Permission mode is applied.
4. Allow rules are checked.
5. `canUseTool` / `can_use_tool` callback handles unresolved prompts unless mode is `dontAsk`.

Deny wins over allow. Scoped deny rules are honored even in bypass mode.

Permission modes:

| Mode | Meaning |
| --- | --- |
| `default` | Unmatched tools prompt via callback; no callback means denial. |
| `dontAsk` | Unmatched tools are denied without callback. |
| `acceptEdits` | Auto-approves `Edit`, `Write`, and common filesystem commands in allowed directories. |
| `plan` | Read-only exploration and planning, no source edits. |
| `auto` | TypeScript-only model-classified approvals where available. |
| `bypassPermissions` | Approves all tools that reach this step. Use only in isolated environments. |

Accept-edits mode approves file edits and common filesystem commands such as `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, and `sed`, only inside `cwd` and `additionalDirectories` / `add_dirs`. Other commands still need approval/rules.

Subagents inherit parent `bypassPermissions`, `acceptEdits`, and `auto` in ways that cannot always be overridden per subagent. Be especially careful with `bypassPermissions` plus subagents.

### Interactive Approval

TypeScript:

```ts
const options = {
  canUseTool: async (toolName: string, input: any, { suggestions = [] } = {}) => {
    if (toolName === "Bash" && String(input.command).includes("rm ")) {
      return { behavior: "deny", message: "Deletion commands require a separate workflow." };
    }
    return { behavior: "allow", updatedInput: input };
  },
};
```

Python:

```py
from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny


async def can_use_tool(tool_name, input_data, context):
    if tool_name == "Bash" and "rm " in input_data.get("command", ""):
        return PermissionResultDeny(message="Deletion commands require a separate workflow.")
    return PermissionResultAllow(updated_input=input_data)
```

Python caveat from the docs: `can_use_tool` requires streaming input mode plus a dummy `PreToolUse` hook that returns `{"continue_": True}` to keep the stream open for permission callbacks. Build Python interactive approval flows with `ClaudeSDKClient` or an async prompt stream.

## AskUserQuestion And Clarifying Input

`AskUserQuestion` is a built-in tool for Claude-generated clarification questions. Your app handles it through the same permission callback:

1. Include `AskUserQuestion` in `tools` if you restrict the tool list.
2. In `canUseTool` / `can_use_tool`, branch on `toolName == "AskUserQuestion"`.
3. Render the `questions` array to the user.
4. Return the original `questions` plus an `answers` map.

Question format:

```json
{
  "questions": [
    {
      "question": "Which output format should I use?",
      "header": "Format",
      "options": [
        { "label": "Brief", "description": "Short summary" },
        { "label": "Detailed", "description": "Full report" }
      ],
      "multiSelect": false
    }
  ]
}
```

Response format:

```ts
return {
  behavior: "allow",
  updatedInput: {
    questions: input.questions,
    answers: {
      "Which output format should I use?": "Detailed",
    },
  },
};
```

Limits:

- 1-4 questions per call.
- 2-4 options per question.
- Not currently available inside subagents spawned by the `Agent` tool.

TypeScript can request option previews with:

```ts
const options = {
  toolConfig: {
    askUserQuestion: { previewFormat: "html" },
  },
};
```

Preview HTML is sanitized by the SDK to reject scripts, styles, and document declarations before it reaches your callback.

## Hooks

Hooks are deterministic callbacks fired at lifecycle points. They can log, audit, block, modify inputs, add context, or perform side effects.

Available hook events include:

| Event | Python | TypeScript | Use |
| --- | --- | --- | --- |
| `PreToolUse` | Yes | Yes | Validate, modify, allow, ask, deny, or defer a tool call. |
| `PostToolUse` | Yes | Yes | Audit or transform tool output. |
| `PostToolUseFailure` | Yes | Yes | Handle failed tool execution. |
| `PostToolBatch` | No | Yes | React after a whole batch of tool calls resolves. |
| `UserPromptSubmit` | Yes | Yes | Inject context into prompts. |
| `Stop` | Yes | Yes | Save state or validate final response. |
| `SubagentStart` | Yes | Yes | Track subagent launch. |
| `SubagentStop` | Yes | Yes | Aggregate subagent results. |
| `PreCompact` | Yes | Yes | Archive transcript before compaction. |
| `PermissionRequest` | Yes | Yes | Notify when approval is needed. |
| `Notification` | Yes | Yes | Forward status notifications. |
| `SessionStart`, `SessionEnd` | Filesystem-only in Python | Yes | Session lifecycle. |
| `Setup`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove` | No | Yes | Advanced TypeScript lifecycle events. |

Hook configuration:

```ts
const options = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [async (input) => {
          const command = String((input as any).tool_input?.command ?? "");
          if (command.includes("rm -rf")) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "Refusing recursive deletion.",
              },
            };
          }
          return {};
        }],
      },
    ],
  },
};
```

Matchers are regex strings. For tool hooks, matchers match tool names only, not arguments or file paths. Inspect `tool_input` in the callback to filter by path/command.

Hook callback inputs:

- Event-specific input object.
- Tool use ID, when relevant.
- Context object. TypeScript includes an `AbortSignal`; Python reserves this for future use.

Top-level output fields:

- `systemMessage`: visible to the user/application, not necessarily to Claude.
- `continue` / `continue_`: whether the agent should continue.
- `async` / `async_`: let the agent continue without waiting for a side-effect hook.

`hookSpecificOutput` fields depend on event:

- `PreToolUse`: `permissionDecision`, `permissionDecisionReason`, `updatedInput`.
- `PostToolUse`: `additionalContext`, `updatedToolOutput`.

Permission decision priority: deny > defer > ask > allow.

Programmatic hooks run in your application process. Filesystem hooks from `.claude/settings.json` can also load through setting sources and run alongside programmatic hooks.

## Streaming Input

Two input modes exist:

| Mode | Best for | Limitations |
| --- | --- | --- |
| Streaming input | Chat UIs, image uploads, queued messages, interrupts, permission prompts, hooks, long-running sessions | More moving parts. |
| Single string prompt | One-shot calls, simple scripts, stateless tasks | No direct image attachments, dynamic message queueing, real-time interruption, hook integration, or natural multi-turn conversation. |

TypeScript streaming input:

```ts
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

async function* messages(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Analyze this repository for security issues.",
    },
    parent_tool_use_id: null,
  };
}

for await (const message of query({
  prompt: messages(),
  options: { allowedTools: ["Read", "Grep", "Glob"], maxTurns: 10 },
})) {
  // Render stream.
}
```

Python streaming input is usually cleaner with `ClaudeSDKClient`.

## Streaming Output

By default, you receive complete assistant messages after each Claude response. To stream deltas:

- TypeScript: `includePartialMessages: true`
- Python: `include_partial_messages=True`

Then handle raw stream events:

```ts
for await (const message of query({
  prompt: "Explain this project",
  options: { includePartialMessages: true },
})) {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text);
    }
  }
}
```

Tool calls stream with:

- `content_block_start` where block type is `tool_use`.
- `content_block_delta` where delta type is `input_json_delta`.
- `content_block_stop`.

Streaming limitations:

- Explicit `max_thinking_tokens` / `maxThinkingTokens` disables `StreamEvent` messages.
- Structured output appears only in the final result's `structured_output` / `structured_output`, not as deltas.

## Structured Output

Structured outputs validate final agent output against JSON Schema. Claude can still use tools and multiple turns before returning the final JSON.

TypeScript:

```ts
const schema = {
  type: "object",
  properties: {
    risk: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          issue: { type: "string" },
        },
        required: ["file", "issue"],
      },
    },
  },
  required: ["risk", "summary", "findings"],
};

for await (const message of query({
  prompt: "Review this repository for security issues.",
  options: {
    outputFormat: { type: "json_schema", schema },
    allowedTools: ["Read", "Glob", "Grep"],
  },
})) {
  if (message.type === "result") {
    if (message.subtype === "success") {
      console.log(message.structured_output);
    }
  }
}
```

Python:

```py
options = ClaudeAgentOptions(
    output_format={"type": "json_schema", "schema": schema},
    allowed_tools=["Read", "Glob", "Grep"],
)
```

Use Zod in TypeScript and Pydantic in Python for type-safe schema generation and runtime validation.

Failure subtype:

- `error_max_structured_output_retries`: validation failed too many times.

Tips:

- Keep schemas focused.
- Make unavailable fields optional.
- Use enums for constrained choices.
- Ask explicitly for the information needed by the schema.

## Sessions

Sessions are conversation transcripts persisted to disk under `~/.claude/projects/`. They include prompts, tool calls, tool results, and assistant responses. They do not snapshot filesystem state.

Choose a session pattern:

| Need | Pattern |
| --- | --- |
| One-shot task | Single `query()` call. |
| Python multi-turn in one process | `ClaudeSDKClient`. |
| TypeScript continue most recent | `continue: true`. |
| Resume a specific session | Capture `session_id` and pass `resume`. |
| Explore a branch | Pass `resume` plus `forkSession` / `fork_session`. |
| Stateless TS call with no disk session | `persistSession: false` TypeScript-only. |
| Multi-host resume | Use `sessionStore` / `session_store`. |

Capture session ID from result:

```ts
let sessionId: string | undefined;
for await (const message of query({ prompt: "Analyze src/" })) {
  if (message.type === "result") sessionId = message.session_id;
}
```

Resume:

```ts
for await (const message of query({
  prompt: "Implement the refactor you suggested.",
  options: { resume: sessionId, allowedTools: ["Read", "Edit", "Write", "Grep"] },
})) {
  // ...
}
```

Fork:

```ts
for await (const message of query({
  prompt: "Try the alternate OAuth approach.",
  options: { resume: sessionId, forkSession: true },
})) {
  // The result session_id is the fork's new ID.
}
```

Resume gotcha: `cwd` must match the original session path unless you use external session storage. The local session path encodes absolute `cwd`.

## External Session Storage

By default, session transcripts are local JSONL files. `SessionStore` mirrors transcripts to your backend so any host can resume them.

Use cases:

- Serverless/autoscaled workers.
- Durable storage for ephemeral containers.
- Audit/compliance retention.
- User session pickers.

Core interface:

- Required `append(key, entries)`.
- Required `load(key)`.
- Optional `listSessions`, `delete`, `listSubkeys`.

TypeScript development store:

```ts
import { InMemorySessionStore, query } from "@anthropic-ai/claude-agent-sdk";

const store = new InMemorySessionStore();

let sessionId: string | undefined;
for await (const message of query({
  prompt: "List source files.",
  options: { sessionStore: store },
})) {
  if (message.type === "result") sessionId = message.session_id;
}

for await (const message of query({
  prompt: "Summarize those files.",
  options: { sessionStore: store, resume: sessionId },
})) {
  // ...
}
```

Behavior notes:

- SessionStore is a mirror, not a replacement. The subprocess writes local disk first.
- Point `CLAUDE_CONFIG_DIR` at temp storage if local transcripts should be ephemeral.
- `sessionStore` cannot be combined with `persistSession: false`.
- `sessionStore` cannot be combined with file checkpointing.
- Mirror writes are best-effort. Watch for `mirror_error` system messages.
- For subagent resume, implement `listSubkeys`.
- SDK never deletes from your store automatically; implement retention.

Official TypeScript examples include S3, Redis, and Postgres adapters in the SDK repository's `examples/session-stores/` directory.

## File Checkpointing

File checkpointing lets you rewind file changes made by SDK tools.

Tracked:

- `Write`
- `Edit`
- `NotebookEdit`

Not tracked:

- Bash changes like `echo > file`, `sed -i`, `rm`, generated files from commands.
- Directory creation/deletion.
- Remote/network files.

Enable:

```ts
const q = query({
  prompt: "Refactor the auth module.",
  options: {
    enableFileCheckpointing: true,
    permissionMode: "acceptEdits",
    extraArgs: { "replay-user-messages": null },
  },
});
```

Capture a checkpoint from user messages:

```ts
let checkpointId: string | undefined;
let sessionId: string | undefined;

for await (const message of q) {
  if (message.type === "user" && message.uuid) checkpointId = message.uuid;
  if ("session_id" in message) sessionId = message.session_id;
}
```

Rewind after the stream has ended:

```ts
const rewindQuery = query({
  prompt: "",
  options: {
    enableFileCheckpointing: true,
    resume: sessionId,
    extraArgs: { "replay-user-messages": null },
  },
});

for await (const message of rewindQuery) {
  await rewindQuery.rewindFiles(checkpointId!);
  break;
}
```

The rewind changes files on disk but does not rewind the conversation history.

## Subagents

Subagents are isolated agent instances spawned by the parent through the `Agent` tool.

Use subagents for:

- Context isolation.
- Parallel research/review.
- Specialized prompts.
- Restricted tool surfaces.

Subagent creation modes:

| Mode | Notes |
| --- | --- |
| Programmatic `agents` option | Recommended for SDK apps. |
| Filesystem `.claude/agents/*.md` | Shared with Claude Code CLI. |
| Built-in `general-purpose` | Available when `Agent` is allowed. |

Programmatic TypeScript example:

```ts
const options = {
  allowedTools: ["Read", "Glob", "Grep", "Agent"],
  agents: {
    "code-reviewer": {
      description: "Use for security and maintainability code reviews.",
      prompt: "You are a strict reviewer. Find concrete bugs and risks. Do not edit files.",
      tools: ["Read", "Glob", "Grep"],
      model: "sonnet",
      maxTurns: 20,
    },
  },
};
```

Python uses `AgentDefinition`; its fields intentionally use camelCase to match the wire format.

AgentDefinition fields:

| Field | Purpose |
| --- | --- |
| `description` | Tells Claude when to use this subagent. Required. |
| `prompt` | Subagent system prompt. Required. |
| `tools` | Allowed tool names. Omit to inherit available tools. |
| `disallowedTools` | Remove tools from subagent surface. |
| `model` | Alias such as `sonnet`, `opus`, `haiku`, `inherit`, or full model ID. |
| `skills` | Skills to preload. |
| `memory` | `user`, `project`, or `local`. |
| `mcpServers` | MCP servers available to this subagent. |
| `maxTurns` | Turn cap. |
| `background` | Run as non-blocking background task. |
| `effort` | Reasoning effort. |
| `permissionMode` | Permission mode for the subagent, subject to inheritance caveats. |

Subagents inherit:

- Their own prompt.
- The Agent tool's prompt string.
- Project `CLAUDE.md` if loaded.
- Tool definitions from parent or restricted `tools` list.

Subagents do not inherit:

- Parent conversation history.
- Parent tool results.
- Parent system prompt.
- Preloaded parent skill content unless listed in `skills`.

Subagents cannot spawn their own subagents. Do not include `Agent` in a subagent `tools` list.

To force a specific subagent, name it in the prompt: "Use the code-reviewer agent to review src/auth.ts."

Detect subagents by watching assistant `tool_use` blocks named `Agent` or legacy `Task`. Messages from inside a subagent include `parent_tool_use_id`.

Subagent transcript notes:

- Main conversation compaction does not compact subagent transcript files.
- Subagent transcripts persist in the session and can be resumed by agent ID.
- Cleanup follows `cleanupPeriodDays`, default 30 days.

## Skills

Skills are filesystem artifacts, not programmatic API objects.

Locations:

- Project: `.claude/skills/<name>/SKILL.md`
- User: `~/.claude/skills/<name>/SKILL.md`
- Plugins: plugin `skills/` directories

SDK behavior:

- Discovered through `settingSources` / `setting_sources`.
- Metadata loads at startup.
- Full content loads when Claude invokes the skill.
- Omitted `skills` option enables discovered skills, matching CLI behavior.
- `skills: "all"` enables all discovered skills.
- `skills: ["pdf", "docx"]` enables only named skills.
- `skills: []` disables all skills.
- Setting `skills` automatically enables the `Skill` tool; do not list it in `allowedTools`.

Tool restriction gotcha: `allowed-tools` frontmatter in `SKILL.md` applies to Claude Code CLI directly, not SDK skill usage. In SDK applications, enforce tool permissions with the main SDK options and permission flow.

The `skills` option is not a filesystem sandbox. Hidden skills can still be read by `Read` or shell tools if those tools can access the files.

## Slash Commands

Slash commands can be sent as prompt strings:

```ts
for await (const message of query({
  prompt: "/compact",
  options: { maxTurns: 1 },
})) {
  // Watch for compact boundary/system messages.
}
```

Discover available commands from the init/system message.

Common built-ins include:

- `/compact`
- `/context`
- `/usage`

The interactive CLI `/clear` is not available in the SDK. To clear context, end the current query and start a new one.

Custom commands:

- Legacy location: `.claude/commands/*.md` or `~/.claude/commands/*.md`.
- Recommended newer pattern: skills, which can be invoked with `/skill-name` and autonomously selected by Claude.

Commands support:

- YAML frontmatter such as `description`, `argument-hint`, `allowed-tools`, `model`.
- `$1`, `$2`, and `$ARGUMENTS` placeholders.
- Bash output injection with `!` backtick syntax.
- File references with `@path`.
- Subdirectories for organization, though command names remain based on filenames.

Only commands that work without an interactive terminal are dispatchable through the SDK.

## Plugins

Plugins package Claude Code extensions:

- Skills.
- Agents.
- Hooks.
- MCP servers.
- Legacy commands.

SDK plugin loading currently supports local filesystem paths:

```ts
const options = {
  plugins: [
    { type: "local", path: "./plugins/my-plugin" },
    { type: "local", path: "/absolute/path/to/another-plugin" },
  ],
};
```

The path must point at the plugin root containing `.claude-plugin/plugin.json`.

Plugin skills are namespaced as `plugin-name:skill-name` for slash invocation.

Verify plugin load from the init/system message:

- `plugins`
- `slash_commands`
- available agents/skills depending on SDK message shape

Troubleshooting:

- Ensure path points to the plugin root.
- Validate `.claude-plugin/plugin.json`.
- Check read permissions.
- Use namespace for plugin skills.
- Prefer absolute paths if relative path resolution is confusing.

## Task And Todo Progress

Older SDK sessions used `TodoWrite`. As of TypeScript Agent SDK `0.3.142` and Claude Code `2.1.142`, the default is structured Task tools:

- `TaskCreate`
- `TaskUpdate`
- `TaskGet`
- `TaskList`

`TodoWrite` rewrites an entire todo array. Task tools are incremental:

| Old | New |
| --- | --- |
| `TodoWrite` full array | `TaskCreate` one item, `TaskUpdate` one item |
| `content`, `status`, `activeForm` | `subject`, `description`, `activeForm`, `metadata`, `taskId`, `status` |
| Watch one tool | Watch `TaskCreate` and `TaskUpdate` |

Minimal progress monitor:

```ts
for await (const message of query({ prompt: "Optimize the React app." })) {
  if (message.type !== "assistant") continue;
  for (const block of message.message.content) {
    if (block.type !== "tool_use") continue;
    if (block.name === "TaskCreate") {
      console.log(`+ ${(block.input as any).subject}`);
    }
    if (block.name === "TaskUpdate") {
      const input = block.input as any;
      if (input.status) console.log(`${input.taskId} -> ${input.status}`);
    }
  }
}
```

To force old `TodoWrite` examples for legacy sessions, set `CLAUDE_CODE_ENABLE_TASKS=0`, but prefer Task tools for new code.

## Cost And Usage

Cost fields are client-side estimates, not billing authority. The SDK computes them with a bundled price table that can drift from actual billing due to pricing changes, unknown models, or billing rules. Use the Usage and Cost API or Console for billing decisions.

Read total estimate from the final result:

```ts
if (message.type === "result") {
  console.log(message.total_cost_usd);
  console.log(message.usage);
  console.log(message.modelUsage);
}
```

Cost model concepts:

- One `query()` call can have multiple steps.
- Each assistant step includes usage.
- Parallel tool calls can produce multiple assistant messages with the same underlying message ID and usage. Deduplicate by message ID when summing per-step usage.
- Each `query()` result contains the estimate for that single call, not a whole multi-call session.
- Failed conversations can still have usage and cost.
- Cache fields include `cache_creation_input_tokens` and `cache_read_input_tokens`.

Prompt caching:

- SDK uses prompt caching automatically.
- Cache TTL is normally 5 minutes for API key/provider auth.
- Set `ENABLE_PROMPT_CACHING_1H=1` to request one-hour cache writes where appropriate.
- One-hour writes cost more, but can save money for repeated sessions.
- Claude subscription users already receive one-hour TTL automatically according to the current docs.

## Observability

The SDK launches the Claude Code CLI as a child process. Telemetry is emitted by that CLI process through OpenTelemetry environment variables.

Enable:

```ts
const otelEnv = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.com:4318",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer token",
};

const options = {
  env: { ...process.env, ...otelEnv },
};
```

Signals:

| Signal | Enable |
| --- | --- |
| Metrics | `OTEL_METRICS_EXPORTER` |
| Logs/events | `OTEL_LOGS_EXPORTER` |
| Traces | `OTEL_TRACES_EXPORTER` plus `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` |

Do not use the `console` exporter with the SDK, because stdout is the SDK message channel.

Trace spans include:

- `claude_code.interaction`
- `claude_code.llm_request`
- `claude_code.tool`
- `claude_code.tool.blocked_on_user`
- `claude_code.tool.execution`
- `claude_code.hook` with extra beta tracing variables

Tag by service:

```ts
const options = {
  env: {
    ...process.env,
    OTEL_SERVICE_NAME: "support-triage-agent",
    OTEL_RESOURCE_ATTRIBUTES: "service.version=1.4.0,deployment.environment=production",
  },
};
```

Attach user/tenant IDs by percent-encoding them into `OTEL_RESOURCE_ATTRIBUTES`.

Sensitive export variables are opt-in and should be used carefully:

- `OTEL_LOG_USER_PROMPTS=1`
- `OTEL_LOG_TOOL_DETAILS=1`
- `OTEL_LOG_TOOL_CONTENT=1`
- `OTEL_LOG_RAW_API_BODIES=1` or `file:<dir>`

## Hosting And Production Architecture

The Agent SDK is not a stateless model API call. It runs a persistent process that executes commands, accesses a filesystem, manages context, and maintains sessions.

Minimum deployment expectations:

- Run in a sandboxed container or equivalent.
- Allocate roughly 1 GiB RAM, 5 GiB disk, and 1 CPU as a starting point.
- Provide outbound HTTPS to `api.anthropic.com`, or to your proxy/provider endpoints.
- Provide access to only the MCP servers and external services the agent needs.

Common deployment patterns:

| Pattern | Description |
| --- | --- |
| Ephemeral sessions | One container per task, destroyed after completion. Good for one-off jobs. |
| Long-running sessions | Persistent container for chat, monitoring, or proactive agents. |
| Hybrid sessions | Ephemeral containers hydrated with session/history from storage. |
| Single shared container | Multiple agent processes together. Use sparingly because isolation and file conflicts are harder. |

Sandbox providers mentioned by the docs include Modal Sandbox, Cloudflare Sandboxes, Daytona, E2B, Fly Machines, and Vercel Sandbox. Self-hosted options include Docker, gVisor, and Firecracker.

## Security And Sandboxing

Threat model:

- Prompt injection can come from files, web pages, user input, tool output, or external data sources.
- Model errors can also cause unintended actions.
- Treat agent execution like semi-trusted code.

Principles:

- Isolation.
- Least privilege.
- Defense in depth.
- Credential separation.
- Network controls.
- Audit logs.

Built-in controls:

- Permissions system.
- Bash command parsing for permission matching.
- Web search summarization.
- Sandbox mode for Bash commands.

High-security deployment architecture:

1. Run the agent inside an isolation boundary.
2. Mount only necessary files, preferably read-only.
3. Keep credentials outside the boundary.
4. Route outbound traffic through a proxy.
5. Have the proxy enforce allowlists and inject credentials.
6. Log all proxy/tool activity.

Never mount sensitive directories casually. Common dangerous inputs include:

- `.env`, `.env.local`
- `~/.ssh`
- `~/.aws`
- `~/.config/gcloud`
- `~/.azure`
- `~/.docker/config.json`
- `~/.kube/config`
- `.npmrc`, `.pypirc`
- service-account JSON files
- private keys and certificates

### Programmatic Sandbox

TypeScript sandbox example:

```ts
const options = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    network: {
      allowedDomains: ["registry.npmjs.org", "api.github.com"],
      deniedDomains: ["metadata.google.internal"],
      allowLocalBinding: true,
    },
    filesystem: {
      allowWrite: ["/workspace/tmp/**"],
      denyRead: ["/workspace/.env"],
    },
  },
};
```

Python sandbox example:

```py
options = ClaudeAgentOptions(
    sandbox={
        "enabled": True,
        "autoAllowBashIfSandboxed": True,
        "network": {
            "allowedDomains": ["registry.npmjs.org", "api.github.com"],
            "allowLocalBinding": True,
        },
    }
)
```

Sandbox caveats:

- The sandbox proxy enforces domain allowlists by requested hostname and does not inspect TLS by default. Domain fronting may bypass simple hostname-based controls.
- `allowUnixSockets` can grant powerful host access. Allowing `/var/run/docker.sock` effectively grants host control.
- `excludedCommands` always bypass sandbox restrictions.
- `allowUnsandboxedCommands` lets the model request `dangerouslyDisableSandbox`; such calls fall back to permissions.
- `bypassPermissions` plus `allowUnsandboxedCommands` can silently escape the sandbox. Avoid this combination.

## Models, Effort, And Thinking

Set `model` explicitly to pin behavior and cost:

```ts
const options = {
  model: "claude-sonnet-4-6",
  fallbackModel: "claude-haiku-4-5",
};
```

Effort levels:

| Level | Use |
| --- | --- |
| `low` | Fast file lookups, simple tasks. |
| `medium` | Routine edits and analysis. |
| `high` | Debugging and refactors. |
| `xhigh` | Complex coding and agentic tasks. |
| `max` | Deep multi-step reasoning. |

TypeScript defaults effort to `high`. Python leaves it unset unless you specify it.

`effort` is not the same as extended thinking. `effort` controls reasoning depth/latency/cost. `thinking` controls visible thinking blocks and budget configuration where supported.

## Migration From Claude Code SDK

Renames:

| Old | New |
| --- | --- |
| `@anthropic-ai/claude-code` | `@anthropic-ai/claude-agent-sdk` |
| `claude-code-sdk` | `claude-agent-sdk` |
| `claude_code_sdk` import | `claude_agent_sdk` import |
| `ClaudeCodeOptions` | `ClaudeAgentOptions` |

Breaking behavior:

- The SDK no longer defaults to the full Claude Code system prompt. Request `claude_code` preset explicitly if you want old behavior.
- Default settings sources currently load user/project/local settings. If you need isolation, pass `settingSources: []` / `setting_sources=[]` and disable auto-memory.
- Python SDK `0.1.59` and earlier treated empty `setting_sources=[]` like omission. Upgrade before relying on it.
- TypeScript V2 session API (`unstable_v2_*`) was removed in TypeScript Agent SDK `0.3.142`. Use `query()` plus session options instead.

Migration commands:

```bash
npm uninstall @anthropic-ai/claude-code
npm install @anthropic-ai/claude-agent-sdk
```

```bash
pip uninstall claude-code-sdk
pip install claude-agent-sdk
```

## Official Demo Repository

Anthropic maintains `anthropics/claude-agent-sdk-demos` as local-development sample code. The repository warns that the demos are not production deployments and should not be used at scale as-is.

Current demo themes observed on 2026-05-20:

| Demo | What it shows | Notes |
| --- | --- | --- |
| Email Agent | IMAP inbox display, agentic email search, email assistance | In development. Treat as a product-shape example, not production-ready mail infrastructure. |
| Excel Demo | Spreadsheet and Excel workflows | Useful for file/document tool patterns. |
| Hello World | Basic SDK usage | Good starting point for first run. |
| Hello World V2 | `unstable_v2_*` session API | Historical only for new projects. The official docs say the V2 TypeScript session API was removed in SDK `0.3.142`. |
| Research Agent | Multi-agent research with specialized subagents, web search, report synthesis, activity tracking | Good reference for subagent orchestration and progress tracking. |
| AskUserQuestion Previews | Browser UI for `AskUserQuestion` with `previewFormat: "html"` over WebSocket | Good reference for interactive planning and visual choice previews. |
| Simple Chat App | React + Express chat UI, WebSocket conversation loop, streaming responses | Good reference for app/UI integration. |
| Resume Generator | Web search plus `.docx` generation | Good reference for multi-tool document workflows. |

Use the demos to learn architecture patterns, then rebuild production concerns yourself: sandboxing, credentials, tenant isolation, retention, observability, retries, cost controls, and user permission flows.

## Common Agent Recipes

### Read-Only Code Reviewer

```ts
const options = {
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "You are reviewing only. Do not modify files.",
  },
  tools: ["Read", "Glob", "Grep", "AskUserQuestion"],
  allowedTools: ["Read", "Glob", "Grep", "AskUserQuestion"],
  permissionMode: "dontAsk",
  maxTurns: 20,
};
```

### Autonomous Bug Fixer In A Disposable Sandbox

```ts
const options = {
  systemPrompt: { type: "preset", preset: "claude_code" },
  allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
  permissionMode: "acceptEdits",
  maxTurns: 40,
  maxBudgetUsd: 2,
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: ["registry.npmjs.org"] },
  },
};
```

### Custom Domain Agent With Tools Only

```ts
const options = {
  systemPrompt: "You are a billing operations assistant. Use tools for all account facts.",
  tools: [],
  mcpServers: { billing: billingServer },
  allowedTools: ["mcp__billing__*"],
  permissionMode: "dontAsk",
  outputFormat: { type: "json_schema", schema: billingSummarySchema },
};
```

### Multi-Agent Research

```ts
const options = {
  allowedTools: ["Agent", "WebSearch", "WebFetch", "Read", "Glob", "Grep"],
  agents: {
    "market-researcher": {
      description: "Use for market and competitor research.",
      prompt: "Research deeply, cite sources, and return concise findings.",
      tools: ["WebSearch", "WebFetch"],
      model: "sonnet",
      background: true,
    },
    "codebase-analyst": {
      description: "Use for repository architecture and implementation analysis.",
      prompt: "Inspect files and explain implementation tradeoffs.",
      tools: ["Read", "Glob", "Grep"],
    },
  },
  agentProgressSummaries: true,
};
```

### Interactive Planning Flow

```ts
const options = {
  permissionMode: "plan",
  tools: ["Read", "Glob", "Grep", "AskUserQuestion"],
  allowedTools: ["Read", "Glob", "Grep"],
  canUseTool: async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      const answers = await renderQuestionsToUser(input.questions);
      return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
    }
    return { behavior: "deny", message: "Planning only." };
  },
};
```

## Debugging And Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Tool did not run | Not approved, denied, or removed from context | Check `allowedTools`, `disallowedTools`, `permissionMode`, hooks, and `canUseTool`. |
| Claude sees tool but cannot call it | MCP tool not in `allowedTools` | Add `mcp__server__tool` or wildcard. |
| Claude never sees tool | Missing `tools`, bare-name `disallowedTools`, MCP server failed, strict MCP config | Inspect init/system message. |
| Hook not firing | Wrong event name, matcher mismatch, setting sources disabled | Event names are case-sensitive; matchers match tool names. |
| Modified hook input ignored | Missing `hookSpecificOutput` or permission decision | Return `updatedInput` inside `hookSpecificOutput` with `allow` or `ask`. |
| Session resume starts fresh | Wrong `cwd` or missing transcript | Use same working dir or SessionStore. |
| Python permission callback never fires | Not using streaming input/dummy hook | Use `ClaudeSDKClient` or prompt stream plus `PreToolUse` hook returning `continue_`. |
| Native binary missing in TS | Package manager skipped optional dependency | Install optional package or set `pathToClaudeCodeExecutable`. |
| Bun compiled executable cannot find binary | Bundled binary cannot resolve inside `$bunfs` | Use `extractFromBunfs()` and pass `pathToClaudeCodeExecutable`. |
| Cost totals look doubled | Parallel tool messages share an ID | Deduplicate per-step assistant usage by message ID. |
| Checkpoint UUID missing | Missing replay flag | Add `extraArgs: { "replay-user-messages": null }` or Python equivalent. |
| Rewind after stream errors | Query process closed | Resume with empty prompt and call rewind on new query/client. |
| Tool search fails on proxy/Vertex | `tool_reference` not supported | Set `ENABLE_TOOL_SEARCH=false` or compatible model/provider. |
| Telemetry corrupts SDK output | Console exporter writes to stdout | Use OTLP collector, not `console`. |

## Sharp Edges To Remember

- `allowedTools` is not a sandbox. It pre-approves, but does not remove other tools.
- Use `tools` or bare `disallowedTools` to remove built-ins from Claude's context.
- Pair explicit `allowedTools` with `permissionMode: "dontAsk"` for headless locked-down agents.
- Avoid `bypassPermissions` unless the process is isolated and disposable.
- Subagents can magnify permission risk because they inherit certain broad permission modes.
- Skills and slash command files live on disk. Hiding them with `skills` does not prevent `Read`/`Bash` from accessing the files.
- TypeScript `env` replaces the process env. Spread `process.env`.
- Python `TypedDict` config objects are dicts at runtime, not attribute objects.
- File checkpointing does not track Bash-made changes.
- Session resume restores conversation, not files.
- SessionStore mirrors transcripts but still uses local disk first.
- The official demo repo contains a `hello-world-v2` demo, but the V2 TypeScript session API is documented as removed. Do not start new code on `unstable_v2_*`.

## Source Map

Official Agent SDK docs:

- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/quickstart
- https://code.claude.com/docs/en/agent-sdk/agent-loop
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/python
- https://code.claude.com/docs/en/agent-sdk/custom-tools
- https://code.claude.com/docs/en/agent-sdk/mcp
- https://code.claude.com/docs/en/agent-sdk/tool-search
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://code.claude.com/docs/en/agent-sdk/structured-outputs
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/agent-sdk/skills
- https://code.claude.com/docs/en/agent-sdk/slash-commands
- https://code.claude.com/docs/en/agent-sdk/plugins
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- https://code.claude.com/docs/en/agent-sdk/todo-tracking
- https://code.claude.com/docs/en/agent-sdk/cost-tracking
- https://code.claude.com/docs/en/agent-sdk/observability
- https://code.claude.com/docs/en/agent-sdk/hosting
- https://code.claude.com/docs/en/agent-sdk/secure-deployment
- https://code.claude.com/docs/en/agent-sdk/migration-guide
- https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview

Related official/project sources:

- Documentation index: https://code.claude.com/docs/llms.txt
- Demo repository: https://github.com/anthropics/claude-agent-sdk-demos
- TypeScript session-store examples: https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores
- Python package metadata: https://pypi.org/project/claude-agent-sdk/
- MCP specification and concepts: https://modelcontextprotocol.io/
