import { z } from "zod";

/**
 * Minimal zod-v3 → JSON Schema converter, for the SDK's `outputFormat`
 * structured-output option (docs/INTERNAL §3n).
 *
 * WHY HAND-ROLLED: the repo is on zod 3. zod 3.25 does ship a `zod/v4` subpath
 * whose `z.toJSONSchema()` would do this for us, but it only understands v4
 * schema internals — it cannot walk the v3 schemas every prompt in `src/prompts`
 * is already written against. Rewriting those to v4 to gain a converter is a much
 * larger, riskier change than the ~100 lines here. Adding `zod-to-json-schema`
 * would also work; this avoids the dependency for a well-bounded need.
 *
 * SCOPE: exactly the constructs the five agent output schemas use — object,
 * string, number (with min/max), boolean, array, enum, literal, union,
 * discriminated union, record, and the optional/nullable/default/catch wrappers.
 * Anything unrecognised degrades to `{}` (permissive) rather than throwing, so a
 * new construct can never hard-fail a production loop — it just loses
 * enforcement for that one field. `assertFullySupported` (used by the tests)
 * is the strict counterpart that DOES throw, so drift is caught in CI instead.
 *
 * REQUIREDNESS: a key is omitted from `required` when the model is allowed to
 * leave it out. That includes `.catch(...)` fields — `z.string().catch("")`
 * treats a missing key as a parse error and substitutes the fallback, so from the
 * model's side it is optional. Marking it required would make grok fabricate a
 * value where the callsite was happy with the default.
 */

export type JsonSchema = Record<string, unknown>;

/** zod hides the discriminator on `_def`; typeName is the only stable tag in v3. */
function typeName(schema: z.ZodTypeAny): string {
  return (schema as unknown as { _def: { typeName?: string } })._def?.typeName ?? "";
}

function def(schema: z.ZodTypeAny): Record<string, any> {
  return (schema as unknown as { _def: Record<string, any> })._def ?? {};
}

/** Wrappers that do not change the JSON shape, only whether a key must appear. */
const TRANSPARENT = new Set([
  "ZodOptional",
  "ZodDefault",
  "ZodCatch",
  "ZodBranded",
  "ZodReadonly",
  "ZodEffects",
  "ZodPipeline",
]);

/** Peel optional/default/catch/etc. down to the schema that carries the shape. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema;
  for (let i = 0; i < 20; i++) {
    const tn = typeName(cur);
    if (!TRANSPARENT.has(tn)) return cur;
    const d = def(cur);
    // ZodEffects/ZodPipeline nest under different keys than the simple wrappers.
    const inner = d.innerType ?? d.schema ?? d.in ?? d.type;
    if (!inner) return cur;
    cur = inner as z.ZodTypeAny;
  }
  return cur;
}

/** True when the model may omit this key entirely. */
function isOmittable(schema: z.ZodTypeAny): boolean {
  let cur = schema;
  for (let i = 0; i < 20; i++) {
    const tn = typeName(cur);
    // `.catch()` swallows a missing-key error, so it reads as optional too.
    if (tn === "ZodOptional" || tn === "ZodDefault" || tn === "ZodCatch") return true;
    if (!TRANSPARENT.has(tn)) return false;
    const d = def(cur);
    const inner = d.innerType ?? d.schema ?? d.in ?? d.type;
    if (!inner) return false;
    cur = inner as z.ZodTypeAny;
  }
  return false;
}

function stringChecks(schema: z.ZodTypeAny): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const c of def(schema).checks ?? []) {
    if (c.kind === "min") out.minLength = c.value;
    if (c.kind === "max") out.maxLength = c.value;
    if (c.kind === "url") out.format = "uri";
    if (c.kind === "email") out.format = "email";
    if (c.kind === "uuid") out.format = "uuid";
  }
  return out;
}

function numberChecks(schema: z.ZodTypeAny): JsonSchema {
  const d = def(schema);
  const out: JsonSchema = { type: d.typeName === "ZodBigInt" ? "integer" : "number" };
  let int = false;
  for (const c of d.checks ?? []) {
    if (c.kind === "min") out.minimum = c.value;
    if (c.kind === "max") out.maximum = c.value;
    if (c.kind === "int") int = true;
  }
  if (int) out.type = "integer";
  return out;
}

/**
 * Convert a zod schema to a JSON Schema suitable for the SDK's
 * `outputFormat: { type: "json_schema", schema }`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const bare = unwrap(schema);
  const tn = typeName(bare);
  const d = def(bare);

  switch (tn) {
    case "ZodObject": {
      const shape: Record<string, z.ZodTypeAny> = d.shape?.() ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOmittable(value) && !isNullish(value)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties, additionalProperties: false };
      if (required.length) out.required = required;
      return out;
    }
    case "ZodString":
      return stringChecks(bare);
    case "ZodNumber":
    case "ZodBigInt":
      return numberChecks(bare);
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: zodToJsonSchema(d.type) };
      if (d.minLength?.value != null) out.minItems = d.minLength.value;
      if (d.maxLength?.value != null) out.maxItems = d.maxLength.value;
      return out;
    }
    case "ZodEnum":
      return { type: "string", enum: [...(d.values ?? [])] };
    case "ZodNativeEnum":
      return { enum: Object.values(d.values ?? {}) };
    case "ZodLiteral":
      return { const: d.value };
    case "ZodNullable": {
      const inner = zodToJsonSchema(d.innerType);
      // `type: [x, "null"]` keeps the sibling keywords (enum, minLength) valid,
      // which an anyOf wrapper would strand.
      if (typeof inner.type === "string") return { ...inner, type: [inner.type, "null"] };
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options: z.ZodTypeAny[] = Array.isArray(d.options) ? d.options : [...(d.options?.values() ?? [])];
      return { anyOf: options.map((o) => zodToJsonSchema(o)) };
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: d.valueType ? zodToJsonSchema(d.valueType) : true };
    case "ZodTuple":
      return { type: "array", items: (d.items ?? []).map((i: z.ZodTypeAny) => zodToJsonSchema(i)) };
    case "ZodAny":
    case "ZodUnknown":
      return {};
    case "ZodNull":
      return { type: "null" };
    default:
      // Unknown construct: stay permissive rather than break a live loop.
      return {};
  }
}

/** `.nullish()` is ZodOptional<ZodNullable<T>>; both layers make a key omittable. */
function isNullish(schema: z.ZodTypeAny): boolean {
  return typeName(schema) === "ZodOptional" || typeName(schema) === "ZodNullable";
}

/**
 * Strict counterpart to the permissive default. Throws on any construct the
 * converter would silently flatten to `{}`, so the test suite fails when a
 * prompt's output schema grows something we do not encode.
 */
export function assertFullySupported(schema: z.ZodTypeAny, path = "$"): void {
  const bare = unwrap(schema);
  const tn = typeName(bare);
  const d = def(bare);
  const KNOWN = new Set([
    "ZodObject", "ZodString", "ZodNumber", "ZodBigInt", "ZodBoolean", "ZodArray",
    "ZodEnum", "ZodNativeEnum", "ZodLiteral", "ZodNullable", "ZodUnion",
    "ZodDiscriminatedUnion", "ZodRecord", "ZodTuple", "ZodNull",
  ]);
  if (!KNOWN.has(tn)) throw new Error(`zodToJsonSchema: unsupported ${tn || "(unknown)"} at ${path}`);

  if (tn === "ZodObject") {
    for (const [k, v] of Object.entries<z.ZodTypeAny>(d.shape?.() ?? {})) assertFullySupported(v, `${path}.${k}`);
  } else if (tn === "ZodArray") {
    assertFullySupported(d.type, `${path}[]`);
  } else if (tn === "ZodNullable") {
    assertFullySupported(d.innerType, path);
  } else if (tn === "ZodUnion" || tn === "ZodDiscriminatedUnion") {
    const options: z.ZodTypeAny[] = Array.isArray(d.options) ? d.options : [...(d.options?.values() ?? [])];
    options.forEach((o, i) => assertFullySupported(o, `${path}|${i}`));
  } else if (tn === "ZodRecord" && d.valueType) {
    assertFullySupported(d.valueType, `${path}{}`);
  }
}
