import type { JsonSchema, JsonValue } from "./types.js";
import { jsonDeepEqual, byteLength } from "./utils.js";

export interface AgentSchemaIssue {
  path: string;
  message: string;
}

/** Thrown by AgentSchema.parse on invalid input; carries safe, structured issues. */
export class AgentSchemaError extends Error {
  readonly issues: AgentSchemaIssue[];
  constructor(issues: AgentSchemaIssue[]) {
    super(issues.map((i) => `${i.path || "$"}: ${i.message}`).join("; ") || "Invalid value");
    this.name = "AgentSchemaError";
    this.issues = issues;
  }
}

export interface AgentSchema<T> {
  /** Agent-visible JSON Schema (draft 2020-12, restricted subset). */
  readonly jsonSchema: JsonSchema;
  /**
   * Validates and returns a typed value. MUST throw `AgentSchemaError`
   * (with a safe, structured message) on invalid input.
   */
  parse(value: unknown): T;
}

/** Minimal Standard Schema mirror (https://standardschema.dev). */
export interface StandardSchemaV1<I = unknown, O = I> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(
      value: unknown,
    ):
      | { value: O; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }
      | Promise<unknown>;
    readonly types?: { readonly input: I; readonly output: O } | undefined;
  };
}

/**
 * Wraps any Standard Schema (Zod ≥3.24, Valibot, ArkType) as an AgentSchema.
 * The JSON Schema MUST be supplied explicitly — core does not depend on a
 * converter (docs/03, D20).
 */
export function fromStandardSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  options: { jsonSchema: JsonSchema },
): AgentSchema<T> {
  return {
    jsonSchema: options.jsonSchema,
    parse(value: unknown): T {
      const result = schema["~standard"].validate(value);
      if (result instanceof Promise) {
        throw new AgentSchemaError([
          { path: "", message: "Async schema validation is not supported in v0.1" },
        ]);
      }
      if (result.issues) {
        throw new AgentSchemaError(
          result.issues.map((issue) => ({
            path: (issue.path ?? [])
              .map((p) => String(typeof p === "object" && p !== null && "key" in p ? p.key : p))
              .join("."),
            message: issue.message,
          })),
        );
      }
      return (result as { value: T }).value;
    },
  };
}

/**
 * Builds an AgentSchema from a raw JSON Schema, validated by the built-in
 * minimal structural validator covering exactly the supported subset.
 */
export function fromJsonSchema<T = JsonValue>(schema: JsonSchema): AgentSchema<T> {
  return {
    jsonSchema: schema,
    parse(value: unknown): T {
      const issues = validateValueAgainstSchema(value, schema, schema, "");
      if (issues.length > 0) throw new AgentSchemaError(issues);
      return value as T;
    },
  };
}

/** Convenience for actions with no input / observations of constant shape. */
export const emptyObjectSchema: AgentSchema<Record<string, never>> = fromJsonSchema({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/* ─────────────────── D19: supported JSON Schema subset ─────────────────── */

const ALLOWED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  // objects
  "properties",
  "required",
  "additionalProperties",
  // arrays
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  // strings
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // numbers
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // unions
  "anyOf",
  // annotations
  "description",
  "default",
  "examples",
  "title",
  "deprecated",
  // refs
  "$defs",
  "$ref",
  // tolerated (converter noise), ignored at validation time
  "$schema",
  "$id",
]);

const REJECTED_KEYWORDS = new Set([
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "prefixItems",
  "contains",
  "propertyNames",
]);

const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const ALLOWED_FORMATS = new Set(["date-time", "date", "uuid", "email", "uri"]);

export interface SchemaSubsetResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validates that a JSON Schema document stays inside the D19 subset.
 * Anything outside MUST be rejected at registration with INVALID_DEFINITION /
 * UNSUPPORTED_SCHEMA (docs/03, docs/07).
 */
export function validateJsonSchemaDocument(
  schema: JsonSchema,
  limits: { maxSchemaBytes: number; maxSchemaDepth: number },
): SchemaSubsetResult {
  const size = byteLength(schema);
  if (size > limits.maxSchemaBytes) {
    return { ok: false, reason: `schema serializes to ${size} bytes (max ${limits.maxSchemaBytes})` };
  }
  return walkSchemaDocument(schema, "", 0, limits.maxSchemaDepth);
}

function walkSchemaDocument(
  node: unknown,
  path: string,
  depth: number,
  maxDepth: number,
): SchemaSubsetResult {
  if (depth > maxDepth) {
    return { ok: false, reason: `schema nesting exceeds depth ${maxDepth} at ${path || "$"}` };
  }
  if (typeof node === "boolean") {
    // Boolean schemas only allowed as additionalProperties (handled by caller).
    return { ok: false, reason: `boolean schema not supported at ${path || "$"}` };
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return { ok: false, reason: `schema must be an object at ${path || "$"}` };
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (REJECTED_KEYWORDS.has(key) || !ALLOWED_KEYWORDS.has(key)) {
      return { ok: false, reason: `unsupported keyword "${key}" at ${path || "$"}` };
    }
  }
  if ("$ref" in obj) {
    const ref = obj.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
      return { ok: false, reason: `only internal "#/$defs/..." refs are supported at ${path || "$"}` };
    }
  }
  if ("type" in obj) {
    const t = obj.type;
    const types = Array.isArray(t) ? t : [t];
    for (const one of types) {
      if (typeof one !== "string" || !ALLOWED_TYPES.has(one)) {
        return { ok: false, reason: `unsupported type "${String(one)}" at ${path || "$"}` };
      }
    }
  }
  if ("format" in obj) {
    const f = obj.format;
    if (typeof f !== "string" || !ALLOWED_FORMATS.has(f)) {
      return { ok: false, reason: `unsupported format "${String(obj.format)}" at ${path || "$"}` };
    }
  }
  if ("additionalProperties" in obj && typeof obj.additionalProperties !== "boolean") {
    return {
      ok: false,
      reason: `additionalProperties must be a boolean at ${path || "$"}`,
    };
  }
  if ("items" in obj) {
    if (Array.isArray(obj.items)) {
      return { ok: false, reason: `tuple "items" arrays are not supported at ${path || "$"}` };
    }
    const r = walkSchemaDocument(obj.items, `${path}.items`, depth + 1, maxDepth);
    if (!r.ok) return r;
  }
  if ("properties" in obj) {
    const props = obj.properties;
    if (typeof props !== "object" || props === null || Array.isArray(props)) {
      return { ok: false, reason: `properties must be an object at ${path || "$"}` };
    }
    for (const [name, sub] of Object.entries(props)) {
      const r = walkSchemaDocument(sub, `${path}.properties.${name}`, depth + 1, maxDepth);
      if (!r.ok) return r;
    }
  }
  if ("anyOf" in obj) {
    if (!Array.isArray(obj.anyOf) || obj.anyOf.length === 0) {
      return { ok: false, reason: `anyOf must be a non-empty array at ${path || "$"}` };
    }
    for (let i = 0; i < obj.anyOf.length; i++) {
      const r = walkSchemaDocument(obj.anyOf[i], `${path}.anyOf[${i}]`, depth + 1, maxDepth);
      if (!r.ok) return r;
    }
  }
  if ("$defs" in obj) {
    const defs = obj.$defs;
    if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
      return { ok: false, reason: `$defs must be an object at ${path || "$"}` };
    }
    for (const [name, sub] of Object.entries(defs)) {
      const r = walkSchemaDocument(sub, `${path}.$defs.${name}`, depth + 1, maxDepth);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

/* ─────────────── built-in structural value validator ─────────────── */

const FORMAT_VALIDATORS: Record<string, (s: string) => boolean> = {
  "date-time": (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s),
};

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return "number";
  return t;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/**
 * Validates a value against a subset schema. Returns issues (empty = valid).
 * JSON Schema semantics: `default` is annotation-only and never applied.
 */
export function validateValueAgainstSchema(
  value: unknown,
  schema: unknown,
  root: JsonSchema,
  path: string,
): AgentSchemaIssue[] {
  if (typeof schema !== "object" || schema === null) return [];
  let node = schema as Record<string, unknown>;

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const defName = ref.slice("#/$defs/".length);
    const defs = root.$defs as Record<string, unknown> | undefined;
    const resolved = defs?.[defName];
    if (typeof resolved !== "object" || resolved === null) {
      return [{ path, message: `unresolvable $ref "${ref}"` }];
    }
    node = resolved as Record<string, unknown>;
  }

  const issues: AgentSchemaIssue[] = [];

  if ("const" in node) {
    if (!jsonDeepEqual(value as JsonValue, node.const as JsonValue)) {
      issues.push({ path, message: `must equal the constant ${JSON.stringify(node.const)}` });
      return issues;
    }
  }

  if (Array.isArray(node.enum)) {
    const ok = node.enum.some((candidate) => jsonDeepEqual(value as JsonValue, candidate as JsonValue));
    if (!ok) {
      issues.push({ path, message: `must be one of ${JSON.stringify(node.enum)}` });
      return issues;
    }
  }

  if (Array.isArray(node.anyOf)) {
    const anyOk = node.anyOf.some(
      (branch) => validateValueAgainstSchema(value, branch, root, path).length === 0,
    );
    if (!anyOk) {
      issues.push({ path, message: "does not match any allowed variant" });
      return issues;
    }
  }

  if ("type" in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const ok = types.some((t) => typeof t === "string" && matchesType(value, t));
    if (!ok) {
      issues.push({
        path,
        message: `expected ${types.join(" | ")}, got ${typeOfValue(value)}`,
      });
      return issues;
    }
  }

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      issues.push({ path, message: `must be at least ${node.minLength} characters` });
    }
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      issues.push({ path, message: `must be at most ${node.maxLength} characters` });
    }
    if (typeof node.pattern === "string") {
      let re: RegExp | undefined;
      try {
        re = new RegExp(node.pattern);
      } catch {
        // invalid pattern is a schema-document defect; ignore at value time
      }
      if (re && !re.test(value)) {
        issues.push({ path, message: `must match pattern ${node.pattern}` });
      }
    }
    if (typeof node.format === "string") {
      const check = FORMAT_VALIDATORS[node.format];
      if (check && !check(value)) {
        issues.push({ path, message: `must be a valid ${node.format}` });
      }
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      issues.push({ path, message: `must be >= ${node.minimum}` });
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      issues.push({ path, message: `must be <= ${node.maximum}` });
    }
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) {
      issues.push({ path, message: `must be > ${node.exclusiveMinimum}` });
    }
    if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) {
      issues.push({ path, message: `must be < ${node.exclusiveMaximum}` });
    }
    if (typeof node.multipleOf === "number" && node.multipleOf > 0) {
      const quotient = value / node.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        issues.push({ path, message: `must be a multiple of ${node.multipleOf}` });
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      issues.push({ path, message: `must have at least ${node.minItems} items` });
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      issues.push({ path, message: `must have at most ${node.maxItems} items` });
    }
    if (node.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          issues.push({ path, message: "items must be unique" });
          break;
        }
        seen.add(key);
      }
    }
    if (node.items !== undefined) {
      value.forEach((item, i) => {
        issues.push(...validateValueAgainstSchema(item, node.items, root, `${path}[${i}]`));
      });
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const props = (node.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(node.required)) {
      for (const req of node.required) {
        if (typeof req === "string" && record[req] === undefined) {
          issues.push({ path: path ? `${path}.${req}` : req, message: "is required" });
        }
      }
    }
    for (const [name, sub] of Object.entries(props)) {
      if (record[name] !== undefined) {
        issues.push(
          ...validateValueAgainstSchema(record[name], sub, root, path ? `${path}.${name}` : name),
        );
      }
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in props)) {
          issues.push({
            path: path ? `${path}.${key}` : key,
            message: "is not an allowed property",
          });
        }
      }
    }
  }

  return issues;
}
