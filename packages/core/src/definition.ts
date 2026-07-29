import type {
  AgentConsumer,
  AgentProcedureEffect,
  AgentSurfaceLimits,
  JsonSchema,
  JsonValue,
} from "./types.js";
import type { AgentSchema } from "./schema.js";
import { validateJsonSchemaDocument } from "./schema.js";
import type { AgentPolicy } from "./policy.js";
import { AgentSurfaceDefinitionError } from "./errors.js";
import {
  isValidCapabilityName,
  isValidComponentType,
  isValidInstanceId,
  formatViewCapabilityId,
  MAX_ID_LENGTH,
} from "./ids.js";
import { byteLength, isJsonValue } from "./utils.js";

/* ───────────────────────── handler contexts ───────────────────────── */

export interface AgentReadContext {
  capabilityId: string;
  registrationId: string;
  consumer: AgentConsumer;
  /** Host context (user, tenant, env…) from RegistryOptions.context(). */
  host: Readonly<Record<string, unknown>>;
}

export interface AgentActionContext extends AgentReadContext {
  invocationId: string;
  /** Aborted on timeout, external cancellation, or unmount. Cooperative. */
  signal: AbortSignal;
  /** Present iff this invocation carries approved confirmation evidence. */
  confirmation?: { id: string; approvedAt: string };
}

export interface PreconditionFailure {
  message: string; // agent-safe
  details?: Record<string, JsonValue>; // agent-safe
}

/* ───────────────────────── capability definitions ───────────────────────── */

export interface AgentObservationDefinition<TOut extends JsonValue> {
  /** Agent-visible description, ≤ 300 chars. */
  description: string;
  output: AgentSchema<TOut>;
  /**
   * Reads current semantic state. MUST be side-effect free. SHOULD be
   * synchronous; MAY return a promise (subject to observation timeout).
   */
  read(ctx: AgentReadContext): TOut | Promise<TOut>;
  /** Availability predicate, re-evaluated at snapshot and at invocation. */
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  policies?: AgentPolicy[];
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
}

export interface AgentActionDefinition<
  TIn extends JsonValue,
  TOut extends JsonValue | void = void,
> {
  description: string;
  input: AgentSchema<TIn>;
  output?: AgentSchema<Exclude<TOut, void>>;
  /** View actions MUST be "local-state" | "navigation" (plane rule, docs/01). */
  effect: "local-state" | "navigation";
  idempotent?: boolean; // default false
  reversible?: boolean; // default true
  confirmation?: "never" | "optional" | "required"; // default "never"
  audit?: "none" | "metadata" | "full"; // default "metadata"
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  /**
   * Input-aware validation beyond the schema. Return void to pass; return
   * (or throw) a PreconditionFailure to fail with PRECONDITION_FAILED.
   */
  precondition?(input: TIn, ctx: AgentReadContext): void | PreconditionFailure;
  /**
   * TOut is inferred from `output` only (NoInfer): the schema is the source
   * of truth and the handler's return is checked against it.
   */
  execute(input: TIn, ctx: AgentActionContext): NoInfer<TOut> | Promise<NoInfer<TOut>>;
  policies?: AgentPolicy[];
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
}

/** Identity helpers that fix generics for record-literal authoring. */
export function observation<TOut extends JsonValue>(
  def: AgentObservationDefinition<TOut>,
): AgentObservationDefinition<TOut> {
  return def;
}
export function action<TIn extends JsonValue, TOut extends JsonValue | void = void>(
  def: AgentActionDefinition<TIn, TOut>,
): AgentActionDefinition<TIn, TOut> {
  return def;
}
export function defineAgentComponent(def: AgentComponentDefinition): AgentComponentDefinition {
  return def;
}

/* ───────────────────────── procedure references ─────────────────────────
 * Bindings are constructed by @agent-surface/orpc (docs/05); core only
 * consumes this structural shape (zero-dependency rule, docs/02).
 */

export interface ProcedureCallInfo {
  invocationId: string;
  consumer: AgentConsumer;
  signal: AbortSignal;
  confirmation?: { id: string; approvedAt: string };
}

export interface AgentProcedureExecutor {
  execute(req: {
    path: string;
    input: JsonValue; // effective, validated input
    info: ProcedureCallInfo;
  }): Promise<JsonValue>;
  /** Known exposed procedure paths (manifest), used for suffix-collision lint. */
  paths?: ReadonlyArray<string>;
}

export interface AgentProcedureRefDescriptor {
  readonly id: string; // "domain:devices.disable"
  readonly path: string; // "devices.disable"
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly effect: AgentProcedureEffect;
  /** Server-declared flag the client must respect (approval required). */
  readonly requiresApproval?: boolean;
}

export interface AgentProcedureBindingRuntimeConfig {
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  /** UI-derived inputs, evaluated at EXECUTION time (docs/05 rule 4). */
  bind?: () => Record<string, JsonValue>;
  overridableFields?: ReadonlyArray<string>;
  /** Escalate (never lower) the manifest's confirmation requirement. */
  confirmation?: "optional" | "required";
  policies?: AgentPolicy[];
  /** Contextual description appended to the manifest description. */
  describe?: () => string;
  meta?: Record<string, JsonValue>;
}

export interface AgentProcedureBinding<TIn extends object = object, TOut = unknown> {
  readonly kind: "procedure-binding";
  readonly ref: AgentProcedureRefDescriptor;
  readonly config: AgentProcedureBindingRuntimeConfig;
  /** Keys produced by bind(), captured at binding creation. */
  readonly boundKeys: ReadonlyArray<string>;
  /** Bound keys the agent may NOT supply (bound minus overridable). */
  readonly lockedKeys: ReadonlyArray<string>;
  /** Agent-facing (reduced) input schema per D7 rule 1. */
  readonly reducedInputSchema: JsonSchema;
  /** Optional link to the owning view component. */
  contextLink?: { type: string; instanceId: string };
  /** Phantom fields carrying the generics (never read at runtime). */
  readonly __types?: { input: TIn; output: TOut };
}

/* ───────────────────────── component definition ───────────────────────── */

export interface AgentComponentDefinition {
  /** Component type, e.g. "devices.table". MUST match the id grammar. */
  type: string;
  /** Distinguishes simultaneous mounts. Defaults to "default". Data-derived. */
  instanceId?: string;
  /** Agent-visible description, ≤ 500 chars. Required, non-empty. */
  description: string;
  /** Optional containment link for hierarchy-aware consumers. */
  parent?: { type: string; instanceId?: string };
  /** Agent-visible metadata. JsonValue, ≤ 2 kB serialized. */
  meta?: Record<string, JsonValue>;
  /** Internal metadata for policies/audit sinks. NEVER serialized. */
  internal?: Record<string, unknown>;
  /** Policies applied to every capability of this component. */
  policies?: AgentPolicy[];
  /** Registrant trust label; default "first-party". */
  origin?: string;
  /** Snapshot ordering/budget priority; higher survives budgets longer. */
  priority?: number;
  /** Master switch; false ⇒ all capabilities visible-disabled. */
  enabled?: boolean;

  observations?: Record<string, AgentObservationDefinition<any>>;
  actions?: Record<string, AgentActionDefinition<any, any>>;
  /** Domain references; normally added via @agent-surface/orpc. */
  procedures?: AgentProcedureBinding<any, any>[];
}

/* ───────────────────────── definition validation ───────────────────────── */

const COMPONENT_KEYS = new Set([
  "type",
  "instanceId",
  "description",
  "parent",
  "meta",
  "internal",
  "policies",
  "origin",
  "priority",
  "enabled",
  "observations",
  "actions",
  "procedures",
]);

const OBSERVATION_KEYS = new Set([
  "description",
  "output",
  "read",
  "when",
  "unavailableReason",
  "policies",
  "meta",
  "timeoutMs",
]);

const ACTION_KEYS = new Set([
  "description",
  "input",
  "output",
  "effect",
  "idempotent",
  "reversible",
  "confirmation",
  "audit",
  "when",
  "unavailableReason",
  "precondition",
  "execute",
  "policies",
  "meta",
  "timeoutMs",
]);

const VIEW_EFFECTS = new Set(["local-state", "navigation"]);
const SERVER_EFFECTS = new Set([
  "server-query",
  "server-mutation",
  "external-side-effect",
  "destructive",
]);

function fail(code: ConstructorParameters<typeof AgentSurfaceDefinitionError>[0], message: string): never {
  throw new AgentSurfaceDefinitionError(code, message);
}

function checkMeta(meta: unknown, where: string, limits: AgentSurfaceLimits): void {
  if (meta === undefined) return;
  if (!isJsonValue(meta) || typeof meta !== "object" || Array.isArray(meta)) {
    fail("INVALID_DEFINITION", `${where}: meta must be a JsonValue record`);
  }
  if (byteLength(meta) > limits.maxMetaBytes) {
    fail("LIMIT_EXCEEDED", `${where}: meta exceeds ${limits.maxMetaBytes} bytes`);
  }
}

function checkSchema(schema: AgentSchema<any> | undefined, where: string, limits: AgentSurfaceLimits): void {
  if (schema === undefined) return;
  if (typeof schema !== "object" || schema === null || typeof schema.parse !== "function" || typeof schema.jsonSchema !== "object") {
    fail("INVALID_DEFINITION", `${where}: expected an AgentSchema ({ jsonSchema, parse })`);
  }
  const result = validateJsonSchemaDocument(schema.jsonSchema, limits);
  if (!result.ok) fail("UNSUPPORTED_SCHEMA", `${where}: ${result.reason}`);
}

/**
 * Validates a component definition structurally. Throws
 * AgentSurfaceDefinitionError in every environment — structural defects are
 * deterministic code bugs (docs/03 §registry).
 */
export function validateComponentDefinition(
  def: AgentComponentDefinition,
  limits: AgentSurfaceLimits,
  opts: { hasProcedureExecutor: boolean },
): void {
  if (typeof def !== "object" || def === null) {
    fail("INVALID_DEFINITION", "definition must be an object");
  }
  for (const key of Object.keys(def)) {
    if (!COMPONENT_KEYS.has(key)) {
      fail("INVALID_DEFINITION", `unknown definition field "${key}"`);
    }
  }
  if (typeof def.type !== "string" || !isValidComponentType(def.type)) {
    fail("INVALID_ID", `invalid component type "${String(def.type)}"`);
  }
  const instanceId = def.instanceId ?? "default";
  if (!isValidInstanceId(instanceId)) {
    fail("INVALID_ID", `invalid instanceId "${instanceId}" for component "${def.type}"`);
  }
  if (typeof def.description !== "string" || def.description.trim().length === 0) {
    fail("INVALID_DEFINITION", `component "${def.type}": description is required and must be non-empty`);
  }
  if (def.description.length > limits.maxComponentDescription) {
    fail(
      "LIMIT_EXCEEDED",
      `component "${def.type}": description exceeds ${limits.maxComponentDescription} chars`,
    );
  }
  if (def.parent !== undefined) {
    if (
      typeof def.parent !== "object" ||
      def.parent === null ||
      typeof def.parent.type !== "string" ||
      !isValidComponentType(def.parent.type) ||
      (def.parent.instanceId !== undefined && !isValidInstanceId(def.parent.instanceId))
    ) {
      fail("INVALID_DEFINITION", `component "${def.type}": invalid parent link`);
    }
  }
  checkMeta(def.meta, `component "${def.type}"`, limits);
  if (def.priority !== undefined && typeof def.priority !== "number") {
    fail("INVALID_DEFINITION", `component "${def.type}": priority must be a number`);
  }
  if (def.origin !== undefined && typeof def.origin !== "string") {
    fail("INVALID_DEFINITION", `component "${def.type}": origin must be a string`);
  }

  const seenNames = new Set<string>();
  const checkName = (name: string, kind: string): void => {
    if (!isValidCapabilityName(name)) {
      fail("INVALID_ID", `component "${def.type}": invalid ${kind} name "${name}"`);
    }
    const capabilityId = formatViewCapabilityId(def.type, name);
    if (capabilityId.length > MAX_ID_LENGTH) {
      fail("INVALID_ID", `capability id "${capabilityId}" exceeds ${MAX_ID_LENGTH} chars`);
    }
    if (seenNames.has(name)) {
      fail("DUPLICATE_CAPABILITY", `component "${def.type}": duplicate capability name "${name}"`);
    }
    seenNames.add(name);
  };

  for (const [name, obs] of Object.entries(def.observations ?? {})) {
    checkName(name, "observation");
    const where = `observation "${def.type}.${name}"`;
    for (const key of Object.keys(obs)) {
      if (!OBSERVATION_KEYS.has(key)) fail("INVALID_DEFINITION", `${where}: unknown field "${key}"`);
    }
    if (typeof obs.description !== "string" || obs.description.trim().length === 0) {
      fail("INVALID_DEFINITION", `${where}: description is required`);
    }
    if (obs.description.length > limits.maxCapabilityDescription) {
      fail("LIMIT_EXCEEDED", `${where}: description exceeds ${limits.maxCapabilityDescription} chars`);
    }
    if (typeof obs.read !== "function") fail("INVALID_DEFINITION", `${where}: read() is required`);
    checkSchema(obs.output, `${where} output`, limits);
    if (obs.output === undefined) fail("INVALID_DEFINITION", `${where}: output schema is required`);
    checkMeta(obs.meta, where, limits);
  }

  for (const [name, act] of Object.entries(def.actions ?? {})) {
    checkName(name, "action");
    const where = `action "${def.type}.${name}"`;
    for (const key of Object.keys(act)) {
      if (!ACTION_KEYS.has(key)) fail("INVALID_DEFINITION", `${where}: unknown field "${key}"`);
    }
    if (typeof act.description !== "string" || act.description.trim().length === 0) {
      fail("INVALID_DEFINITION", `${where}: description is required`);
    }
    if (act.description.length > limits.maxCapabilityDescription) {
      fail("LIMIT_EXCEEDED", `${where}: description exceeds ${limits.maxCapabilityDescription} chars`);
    }
    if (typeof act.execute !== "function") fail("INVALID_DEFINITION", `${where}: execute() is required`);
    if (!VIEW_EFFECTS.has(act.effect as string)) {
      if (SERVER_EFFECTS.has(act.effect as string)) {
        fail(
          "PLANE_VIOLATION",
          `${where}: view actions cannot declare server effect "${act.effect}" — define an oRPC procedure and reference it (docs/05)`,
        );
      }
      fail("INVALID_DEFINITION", `${where}: effect must be "local-state" or "navigation"`);
    }
    if (act.confirmation !== undefined && !["never", "optional", "required"].includes(act.confirmation)) {
      fail("INVALID_DEFINITION", `${where}: invalid confirmation "${act.confirmation}"`);
    }
    if (act.audit !== undefined && !["none", "metadata", "full"].includes(act.audit)) {
      fail("INVALID_DEFINITION", `${where}: invalid audit level "${act.audit}"`);
    }
    if (act.input === undefined) fail("INVALID_DEFINITION", `${where}: input schema is required`);
    checkSchema(act.input, `${where} input`, limits);
    checkSchema(act.output, `${where} output`, limits);
    checkMeta(act.meta, where, limits);
  }

  const procedures = def.procedures ?? [];
  if (procedures.length > 0 && !opts.hasProcedureExecutor) {
    fail(
      "PLANE_VIOLATION",
      `component "${def.type}": procedure bindings require an installed procedure executor (registry.setProcedureExecutor)`,
    );
  }
  for (const binding of procedures) {
    if (typeof binding !== "object" || binding === null || binding.kind !== "procedure-binding") {
      fail("INVALID_DEFINITION", `component "${def.type}": invalid procedure binding`);
    }
    const ref = binding.ref;
    if (
      typeof ref !== "object" ||
      ref === null ||
      typeof ref.path !== "string" ||
      ref.path.length === 0 ||
      typeof ref.id !== "string" ||
      ref.id !== `domain:${ref.path}` ||
      typeof ref.description !== "string"
    ) {
      fail("INVALID_DEFINITION", `component "${def.type}": procedure binding has an invalid ref`);
    }
    if (!SERVER_EFFECTS.has(ref.effect as string)) {
      fail(
        "PLANE_VIOLATION",
        `procedure "${ref.path}": effect must be one of server-query | server-mutation | external-side-effect | destructive`,
      );
    }
    if (typeof binding.reducedInputSchema !== "object" || binding.reducedInputSchema === null) {
      fail("INVALID_DEFINITION", `procedure "${ref.path}": missing reduced input schema`);
    }
    if (binding.config.confirmation !== undefined && !["optional", "required"].includes(binding.config.confirmation)) {
      fail("INVALID_DEFINITION", `procedure "${ref.path}": invalid confirmation escalation`);
    }
    checkMeta(binding.config.meta, `procedure "${ref.path}"`, limits);
  }
}
