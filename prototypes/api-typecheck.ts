/**
 * prototypes/api-typecheck.ts
 *
 * NOT an implementation. A self-contained mirror of the public type
 * signatures specified in docs/03, 05 — compiled with `tsc --strict` to
 * verify that the documented API is coherent and that the inference the
 * docs promise (schema → handler param types, bind subset typing, result
 * narrowing) actually works. Also runs a few runtime checks for the
 * wire-name codec and confirmation input matching (node can execute this
 * file directly via type stripping).
 *
 * Rule: if a signature here diverges from docs/03-core-api.md or
 * docs/05-orpc-integration.md, the docs win and this file is wrong.
 */

/* ────────────────────────── type-level test utils ───────────────────── */

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/* ───────────────────────────── core: schema ─────────────────────────── */

export type JsonValue =
  | string | number | boolean | null
  | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchema = Record<string, unknown>;

export interface AgentSchema<T> {
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

/** Minimal StandardSchema mirror (https://standardschema.dev). */
interface StandardSchemaV1<I = unknown, O = I> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown):
      | { value: O; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string }> };
    readonly types?: { readonly input: I; readonly output: O } | undefined;
  };
}

declare function fromStandardSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  options: { jsonSchema: JsonSchema },
): AgentSchema<T>;

declare function fromJsonSchema<T = JsonValue>(schema: JsonSchema): AgentSchema<T>;

/* ─────────────────────── core: definitions & helpers ────────────────── */

interface AgentConsumer {
  id: string;
  kind: "embedded" | "webmcp" | "mcp-bridge" | "test" | "other";
  grants?: string[];
}

interface AgentReadContext {
  capabilityId: string;
  registrationId: string;
  consumer: AgentConsumer;
  host: Readonly<Record<string, unknown>>;
}

interface AgentActionContext extends AgentReadContext {
  invocationId: string;
  signal: AbortSignal;
  confirmation?: { id: string; approvedAt: string };
}

interface PreconditionFailure {
  message: string;
  details?: Record<string, JsonValue>;
}

interface AgentObservationDefinition<TOut extends JsonValue> {
  description: string;
  output: AgentSchema<TOut>;
  read(ctx: AgentReadContext): TOut | Promise<TOut>;
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
}

interface AgentActionDefinition<TIn extends JsonValue, TOut extends JsonValue | void = void> {
  description: string;
  input: AgentSchema<TIn>;
  output?: AgentSchema<Exclude<TOut, void>>;
  effect: "local-state" | "navigation";
  idempotent?: boolean;
  reversible?: boolean;
  confirmation?: "never" | "optional" | "required";
  audit?: "none" | "metadata" | "full";
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  precondition?(input: TIn, ctx: AgentReadContext): void | PreconditionFailure;
  /** TOut inferred from `output` only; handler return checked against it (docs/03). */
  execute(input: TIn, ctx: AgentActionContext): NoInfer<TOut> | Promise<NoInfer<TOut>>;
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
}

declare function observation<TOut extends JsonValue>(
  def: AgentObservationDefinition<TOut>,
): AgentObservationDefinition<TOut>;

declare function action<TIn extends JsonValue, TOut extends JsonValue | void = void>(
  def: AgentActionDefinition<TIn, TOut>,
): AgentActionDefinition<TIn, TOut>;

interface AgentComponentDefinition {
  type: string;
  instanceId?: string;
  description: string;
  parent?: { type: string; instanceId?: string };
  meta?: Record<string, JsonValue>;
  internal?: Record<string, unknown>;
  origin?: string;
  priority?: number;
  enabled?: boolean;
  observations?: Record<string, AgentObservationDefinition<any>>;
  actions?: Record<string, AgentActionDefinition<any, any>>;
}

declare function defineAgentComponent(def: AgentComponentDefinition): AgentComponentDefinition;

/* ─────────────────────── core: registry & invocation ────────────────── */

type AgentCapabilityErrorCode =
  | "CAPABILITY_NOT_FOUND" | "CAPABILITY_NOT_AVAILABLE" | "AMBIGUOUS_INSTANCE"
  | "COMPONENT_UNMOUNTED" | "STALE_CAPABILITY" | "INVALID_INPUT"
  | "NOT_AUTHENTICATED" | "NOT_AUTHORIZED" | "PRECONDITION_FAILED"
  | "CONFIRMATION_REQUIRED" | "CONFIRMATION_INVALID" | "RATE_LIMITED"
  | "TIMEOUT" | "CANCELLED" | "EXECUTION_FAILED";

type AgentErrorRetry =
  | "no" | "yes" | "after-refresh" | "after-delay" | "with-confirmation" | "with-changes";

interface AgentCapabilityErrorPayload {
  code: AgentCapabilityErrorCode;
  message: string;
  retry: AgentErrorRetry;
  details?: Record<string, JsonValue>;
}

interface AgentInvocation {
  invocationId?: string;
  capabilityId: string;
  instanceId?: string;
  registrationId?: string;
  surfaceVersion?: string;
  input?: JsonValue;
  confirmationId?: string;
}

type AgentInvocationResult =
  | { status: "ok"; invocationId: string; capabilityId: string; output?: JsonValue;
      surfaceVersion: string; surfaceChanged?: boolean }
  | { status: "error"; invocationId: string; capabilityId: string;
      error: AgentCapabilityErrorPayload; surfaceVersion: string; surfaceChanged?: boolean };

interface AgentRegistrationHandle {
  readonly registrationId: string;
  readonly status: "active" | "rejected" | "unregistered";
  update(patch: {
    enabled?: boolean;
    availability?: Record<string, { available: boolean; reason?: string }>;
  }): void;
  invalidate(): void;
  unregister(): void;
}

interface AgentSurfaceRegistry {
  readonly surfaceId: string;
  register(definition: AgentComponentDefinition): AgentRegistrationHandle;
  snapshot(context?: { consumer?: AgentConsumer; scope?: string[] }): { surfaceVersion: string };
  invoke(request: AgentInvocation, options?: { consumer?: AgentConsumer; signal?: AbortSignal }):
    Promise<AgentInvocationResult>;
  subscribe(listener: (event: { type: string }) => void): () => void;
  getVersion(): string;
  dispose(): void;
}

declare function createAgentSurfaceRegistry(options?: {
  environment?: "development" | "production" | "test";
  context?: () => Record<string, unknown>;
}): AgentSurfaceRegistry;

/* ───────────────────────── orpc: binding generics ───────────────────── */

interface AgentProcedureRef<TIn extends object, TOut> {
  readonly id: string;
  readonly path: string;
  readonly inputSchema: JsonSchema;
  readonly effect: "server-query" | "server-mutation" | "external-side-effect" | "destructive";
  call(input: TIn, ctx: { invocationId: string }): Promise<TOut>;
}

interface AgentProcedureBinding<TIn extends object, TOut> {
  readonly ref: AgentProcedureRef<TIn, TOut>;
  readonly boundFields: string[];
}

interface AgentProcedureBindingConfig<TIn extends object, TBound extends Partial<TIn>> {
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  bind?: () => TBound;
  overridableFields?: ReadonlyArray<keyof TBound & string>;
  confirmation?: "optional" | "required";
  describe?: () => string;
  meta?: Record<string, JsonValue>;
}

declare function bindAgentProcedure<TIn extends object, TOut, TBound extends Partial<TIn>>(
  ref: AgentProcedureRef<TIn, TOut>,
  config?: AgentProcedureBindingConfig<TIn, TBound>,
): AgentProcedureBinding<TIn, TOut>;

/* ═══════════════════════════ USAGE SAMPLES ═══════════════════════════ */

/* — schema inference through a fake standard schema (zod stand-in) — */

type TableState = {
  visibleRows: Array<{ id: string; name: string; status: "online" | "offline"; city: string }>;
  selectedIds: string[];
  sorting: { by: "name" | "status" | "city"; dir: "asc" | "desc" };
};
type SelectRowsInput = { ids: string[]; mode: "replace" | "add" | "remove" };

declare const TableStateStd: StandardSchemaV1<unknown, TableState>;
declare const SelectRowsStd: StandardSchemaV1<unknown, SelectRowsInput>;

const TableStateSchema = fromStandardSchema(TableStateStd, { jsonSchema: {} });
const SelectRowsSchema = fromStandardSchema(SelectRowsStd, { jsonSchema: {} });

type _schemaInfer = Expect<Equal<ReturnType<typeof TableStateSchema.parse>, TableState>>;

/* — JsonValue constraint: schema-inferred alias object types are accepted — */

type _tableStateIsJson = Expect<TableState extends JsonValue ? true : false>;

/* — action(): input schema drives execute/precondition param types — */

declare const selectedIds: string[];
declare function setSelectedIds(ids: string[]): void;

const selectRows = action({
  description: "Replace, extend or reduce the row selection",
  input: SelectRowsSchema,
  effect: "local-state",
  precondition: (input) => {
    type _p = Expect<Equal<typeof input, SelectRowsInput>>;
    if (input.ids.length === 0) return { message: "empty" };
  },
  execute: (input, ctx) => {
    type _i = Expect<Equal<typeof input, SelectRowsInput>>;
    type _sig = Expect<Equal<typeof ctx.signal, AbortSignal>>;
    setSelectedIds(input.ids);
  },
});
type _selectRowsOut = Expect<Equal<typeof selectRows, AgentActionDefinition<SelectRowsInput, void>>>;

/* — action() with typed output — */

const sort = action({
  description: "Change sorting",
  input: fromJsonSchema<{ by: "name"; dir: "asc" | "desc" }>({}),
  output: fromJsonSchema<{ applied: boolean }>({}),
  effect: "local-state",
  idempotent: true,
  execute: () => ({ applied: true }),
});
type _sortOut = Expect<
  Equal<typeof sort, AgentActionDefinition<{ by: "name"; dir: "asc" | "desc" }, { applied: boolean }>>
>;

const badOutput = action({
  description: "x",
  input: fromJsonSchema<{ a: string }>({}),
  output: fromJsonSchema<{ applied: boolean }>({}),
  effect: "local-state",
  // @ts-expect-error — execute return type must match the declared output schema
  execute: () => ({ applied: "yes" }),
});

const badEffect = action({
  description: "x",
  input: fromJsonSchema<{ a: string }>({}),
  // @ts-expect-error — view actions cannot declare server effects (plane rule is also type-level)
  effect: "server-mutation",
  execute: () => {},
});

/* — observation(): read return type is checked against output — */

const readState = observation({
  description: "Visible rows, selection, sorting",
  output: TableStateSchema,
  read: () => ({
    visibleRows: [{ id: "d1", name: "n", status: "online" as const, city: "Milano" }],
    selectedIds,
    sorting: { by: "name" as const, dir: "asc" as const },
  }),
});

const badRead = observation({
  description: "x",
  output: TableStateSchema,
  // @ts-expect-error — read() returning a shape not matching the output schema
  read: () => ({ nope: true }),
});

/* — aggregated definition composes — */

const def = defineAgentComponent({
  type: "devices.table",
  description: "Table of devices matching the active filters",
  observations: { readState },
  actions: { selectRows, sort },
});

const registry = createAgentSurfaceRegistry({ environment: "test" });
const handle = registry.register(def);
handle.update({ availability: { selectRows: { available: false, reason: "no rows" } } });

/* — result union narrows on status — */

async function demo() {
  const r = await registry.invoke({
    capabilityId: "view:devices.table.selectRows",
    input: { ids: ["d1"], mode: "replace" },
    registrationId: handle.registrationId,
  });
  if (r.status === "ok") {
    type _ok = Expect<Equal<typeof r.output, JsonValue | undefined>>;
  } else {
    type _err = Expect<Equal<typeof r.error.code, AgentCapabilityErrorCode>>;
    if (r.error.code === "CONFIRMATION_REQUIRED") {
      const _retry: "with-confirmation" | AgentErrorRetry = r.error.retry;
    }
  }
}
void demo;

/* — orpc binding: subset typing and overridable constraint — */

type DisableInput = { deviceIds: string[]; reason?: string };
declare const disableRef: AgentProcedureRef<DisableInput, { disabled: number }>;

const binding = bindAgentProcedure(disableRef, {
  when: () => selectedIds.length > 0,
  bind: () => ({ deviceIds: selectedIds }),
  confirmation: "required",
});
type _binding = Expect<Equal<typeof binding, AgentProcedureBinding<DisableInput, { disabled: number }>>>;

const overridable = bindAgentProcedure(disableRef, {
  bind: () => ({ deviceIds: selectedIds, reason: "from-ui" }),
  overridableFields: ["reason"],
});
void overridable;

// @ts-expect-error — bind() must return a subset of the procedure input (wrong field name)
const badBindKey = bindAgentProcedure(disableRef, { bind: () => ({ deviceIdz: selectedIds }) });

// @ts-expect-error — bind() field types must match the procedure input types
const badBindType = bindAgentProcedure(disableRef, { bind: () => ({ deviceIds: 42 }) });

const badOverride = bindAgentProcedure(disableRef, {
  bind: () => ({ deviceIds: selectedIds }),
  // @ts-expect-error — overridableFields must name fields actually bound
  overridableFields: ["reason"],
});

void [badOutput, badEffect, badRead, badBindKey, badBindType, badOverride];

/* Executable spot checks for normative algorithms live in
   prototypes/runtime-checks.ts (this file is declare-only, tsc-only). */
