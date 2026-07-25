import { z } from "zod";
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * Turn a feature's existing tool contract into in-process MCP tools for the SDK
 * (docs/INTERNAL §3n).
 *
 * WHY THIS IS GENERIC: all five bounded loops already declare their tools the
 * same way — `z.discriminatedUnion("name", [ z.object({ name: z.literal("x"),
 * ...args }), ... ])` — paired with an `executors` map keyed by that same name.
 * That is enough structure to derive SDK `tool()` definitions mechanically, so
 * migrating a feature needs NO hand-written tool declarations and no second
 * source of truth to drift. Add a tool to the union + the executors map, as
 * today, and both runtimes pick it up.
 *
 * The SDK's `tool()` takes a ZodRawShape (a plain `{ key: zodType }` object), so
 * we strip the `name` discriminator off each union member's shape and hand over
 * the rest verbatim — the arg types the model sees are exactly the ones the
 * legacy parser validated.
 */

/** Executor signature used by every existing loop: compact text back to the model. */
export type Executor = (args: Record<string, unknown>) => Promise<string>;

export interface DerivedTool {
  name: string;
  /** The `mcp__<server>__<name>` form. Hooks and allowedTools need THIS, not `name`. */
  qualifiedName: string;
}

function typeName(schema: z.ZodTypeAny): string {
  return (schema as unknown as { _def: { typeName?: string } })._def?.typeName ?? "";
}
function def(schema: z.ZodTypeAny): Record<string, any> {
  return (schema as unknown as { _def: Record<string, any> })._def ?? {};
}

/** Namespace the in-process MCP server is registered under. */
export const MCP_SERVER_NAME = "yoinky";

/** The SDK prefixes in-process MCP tools; a bare tool name matches nothing. */
export function qualify(toolName: string): string {
  return `mcp__${MCP_SERVER_NAME}__${toolName}`;
}

/**
 * Decompose a tool schema into SDK tools bound to their executors.
 *
 * Accepts a discriminated union (every current feature) or a bare object schema
 * (a single-tool loop). Members without a matching executor are skipped — the
 * legacy runner also rejects those, so exposing them would invite a call that
 * can only fail.
 */
export function toolsFromSchema(
  toolSchema: z.ZodTypeAny,
  executors: Record<string, Executor>,
  opts: { onCall?: (name: string, args: Record<string, unknown>, result: string) => void } = {},
): { tools: SdkMcpToolDefinition<any>[]; derived: DerivedTool[] } {
  const members = unionMembers(toolSchema);
  const tools: SdkMcpToolDefinition<any>[] = [];
  const derived: DerivedTool[] = [];

  for (const member of members) {
    const shape: Record<string, z.ZodTypeAny> = def(member).shape?.() ?? {};
    const nameField = shape.name;
    if (!nameField || typeName(nameField) !== "ZodLiteral") continue;
    const toolName = String(def(nameField).value);
    const executor = executors[toolName];
    if (!executor) continue;

    // Everything except the discriminator becomes the tool's argument shape.
    const argsShape: z.ZodRawShape = {};
    for (const [key, value] of Object.entries(shape)) {
      if (key !== "name") argsShape[key] = value;
    }

    const description =
      member.description ??
      nameField.description ??
      `Yoinky loop tool "${toolName}". Returns a short text note.`;

    // The SDK's tool() types want ZodRawShape | zod/v4; v3 raw shapes satisfy the
    // ZodRawShape branch, so the peer-dep warning about zod@4 is cosmetic (§3n).
    // The result is widened to SdkMcpToolDefinition<any> because these shapes are
    // only known at runtime — createSdkMcpServer accepts exactly that.
    const derivedTool = tool(toolName, description, argsShape, async (args) => {
      const callArgs = (args ?? {}) as Record<string, unknown>;
      let text: string;
      try {
        text = await executor(callArgs);
      } catch (err) {
        // Mirror the legacy runner: a tool failure is a note to the model, not
        // a crash, so the loop can still commit to an answer.
        text = `tool failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      opts.onCall?.(toolName, callArgs, text);
      return { content: [{ type: "text" as const, text }] };
    }) as SdkMcpToolDefinition<any>;
    tools.push(derivedTool);
    derived.push({ name: toolName, qualifiedName: qualify(toolName) });
  }

  return { tools, derived };
}

/** Union members for a discriminated/plain union, or the schema itself if it is one object. */
function unionMembers(schema: z.ZodTypeAny): z.ZodTypeAny[] {
  const tn = typeName(schema);
  const d = def(schema);
  if (tn === "ZodDiscriminatedUnion" || tn === "ZodUnion") {
    return Array.isArray(d.options) ? d.options : [...(d.options?.values() ?? [])];
  }
  if (tn === "ZodObject") return [schema];
  return [];
}
