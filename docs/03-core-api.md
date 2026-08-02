# 03 — Core API (`@agent-surface/core`)

## Contract, binding and authority (D40/D41)

`defineAgentComponentContract`, `observationContract`, `actionContract`, and `defineAgentProcedureContract` declare static identity/governance. `.bind()` supplies runtime handlers/state. The compiler virtual module returns a `CapabilityAuthority`; `createAgentSurfaceRegistry({ authority })` refuses construction without it and rejects raw, unknown, stale, incomplete, hash-mismatched or semantically changed bindings. `defineExternalAgentToolContract` plus `createAgentExposureGateway(authority)` applies the same ceiling at provider/MCP assembly.

Raw definition helpers remain inert construction utilities. No published registry can execute them. Repository tests enable a source-only Vitest seam that is neither exported nor shipped.

> [!NOTE]
> **Status: Draft** unless marked otherwise. Every type here is public API and every signature is normative: an implementation MUST NOT change one incompatibly without a spec change. `D…` references resolve in the [decision log](project/13-open-questions.md).

> [!TIP]
> **Reference material, not a tutorial** — and the longest page in the spec. First time through, read [Definitions](#definitions) (what authors write) and [Invocation](#invocation) (what happens when an agent calls); come back for the rest. Application authors rarely touch this API directly, since the [React hooks](04-react-api.md) wrap it — start at [Getting Started](getting-started.md) instead.

Contents: [schemas](#schemas) · [definitions](#definitions) · [registry](#registry) · [registration lifecycle](#registration-lifecycle) · [availability](#availability) · [versioning](#versioning) · [snapshot](#snapshot) · [invocation](#invocation) · [concurrency](#concurrency-timeouts-cancellation) · [events](#events) · [confirmation surface](#confirmation-api) · [toolset](#toolset) · [limits](#limits-and-defaults)

---

## Schemas

Core is schema-library-agnostic. Everything that crosses the agent boundary is described by an `AgentSchema<T>`: a pair of (JSON Schema for the agent, validator for the runtime).

```ts
/** JSON value constraint: every agent-crossing payload MUST be a JsonValue. */
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[] | { [key: string]: JsonValue };

/** A JSON Schema document restricted to the supported subset (see below). */
export type JsonSchema = Record<string, unknown>;

export interface AgentSchema<T> {
  /** Agent-visible JSON Schema (draft 2020-12, restricted subset). */
  readonly jsonSchema: JsonSchema;
  /**
   * Validates and returns a typed value. MUST throw `AgentSchemaError`
   * (with a safe, structured message) on invalid input. MUST NOT coerce
   * in ways the jsonSchema does not describe.
   */
  parse(value: unknown): T;
}
```

### Constructors

```ts
/**
 * Wraps any Standard Schema (https://standardschema.dev) — Zod ≥3.24,
 * Valibot, ArkType — as an AgentSchema. Validation uses `~standard.validate`.
 * The JSON Schema MUST be supplied explicitly (core will not depend on a
 * converter): pass the library's native conversion.
 */
export function fromStandardSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  options: { jsonSchema: JsonSchema },
): AgentSchema<T>;

/**
 * Builds an AgentSchema from a raw JSON Schema. Core ships a minimal
 * structural validator covering exactly the supported subset. `T` is
 * caller-asserted; prefer fromStandardSchema when a schema library is in use.
 */
export function fromJsonSchema<T = JsonValue>(schema: JsonSchema): AgentSchema<T>;

/** Convenience for actions with no input / observations of constant shape. */
export const emptyObjectSchema: AgentSchema<Record<string, never>>;
```

Zod 4 example (the pattern the docs use throughout):

```ts
import { z } from "zod";
const SelectRows = z.object({
  ids: z.array(z.string()).min(1).describe("Device ids to select"),
  mode: z.enum(["replace", "add", "remove"]).default("replace"),
});
const SelectRowsSchema = fromStandardSchema(SelectRows, {
  jsonSchema: z.toJSONSchema(SelectRows),
});
```

### Supported JSON Schema subset (D19, Draft)

Accepted keywords — anything else MUST be rejected at registration with `INVALID_DEFINITION`:

- `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, or an array of these for nullability), `enum`, `const`
- objects: `properties`, `required`, `additionalProperties` (boolean only)
- arrays: `items` (single schema), `minItems`, `maxItems`, `uniqueItems`
- strings: `minLength`, `maxLength`, `pattern`, `format` ∈ {`date-time`, `date`, `uuid`, `email`, `uri`}
- numbers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
- unions: `anyOf` (including discriminated unions by `const` tag); `oneOf`, `allOf`, `not`, `if/then/else`, `patternProperties`, `dependent*`, `unevaluated*` are **not** supported in 0.x
- annotations anywhere: `description`, `default`, `examples`, `title`, `deprecated`
- `$defs` + internal `$ref` (`#/$defs/...`) only; remote refs rejected
- maximum nesting depth: 8; maximum serialized schema size: 16 kB

Rationale: this is the subset current LLM tool-calling implementations handle reliably, and it keeps the core validator small. The subset is validated at **registration time**, so authors discover violations in development, not when an agent calls.

### Serialization rules (D18, Draft)

- All inputs/outputs MUST be `JsonValue`. Dates travel as ISO-8601 strings; binary is unsupported in 0.x (Future: content refs).
- Type-level note: the `extends JsonValue` constraints are satisfied by schema-inferred types and type aliases; TypeScript `interface`s lack implicit index signatures and won't satisfy them — use type aliases (schema inference produces them anyway).
- `undefined` properties are stripped (JSON semantics). Functions, symbols, bigints, and cyclic structures are defects: in development the registry probes outputs (JSON round-trip) and throws; in production the invocation settles as `EXECUTION_FAILED` with a safe message, and the defect is logged.
- Observation/action outputs exceeding `limits.maxOutputBytes` (default 32 kB) settle as `EXECUTION_FAILED` (`details.reason: "output-too-large"`); truncation is never silent.

---

## Definitions

### Component definition

```ts
export interface AgentComponentDefinition {
  /** Component type, e.g. "devices.table". MUST match the id grammar. */
  type: string;
  /**
   * Distinguishes simultaneous mounts of the same type. Defaults to "default".
   * MUST be derived from data (entity id, semantic slot), never render order.
   */
  instanceId?: string;
  /** Agent-visible description, ≤ 500 chars. Required, non-empty. */
  description: string;
  /** Optional containment link for hierarchy-aware consumers. */
  parent?: { type: string; instanceId?: string };
  /** Agent-visible metadata. JsonValue, ≤ 2 kB serialized. */
  meta?: Record<string, JsonValue>;
  /**
   * Internal metadata for policies/audit sinks. NEVER serialized into
   * snapshots or agent-facing payloads (normative; tested).
   */
  internal?: Record<string, unknown>;
  /** Policies applied to every capability of this component. */
  policies?: AgentPolicy[];
  /** Registrant trust label; default "first-party". See 06 §trust. */
  origin?: string;
  /** Snapshot ordering/budget priority; higher survives budgets longer. Default 0. */
  priority?: number;
  /**
   * Master switch. false ⇒ all capabilities are visible-disabled
   * (reason "component-disabled") and invocations fail CAPABILITY_NOT_AVAILABLE.
   * Registration identity is preserved (no version churn beyond the toggle).
   */
  enabled?: boolean;

  observations?: Record<string, AgentObservationDefinition<any>>;
  actions?: Record<string, AgentActionDefinition<any, any>>;
  /** Domain references; normally added via @agent-surface/orpc. */
  procedures?: AgentProcedureBinding<any, any>[];
}
```

### Capability definitions and helpers

Record-literal inference for heterogeneous capability maps is beyond TypeScript's contextual typing, so core provides per-entry builder helpers; they are the recommended authoring style (verified in `prototypes/api-typecheck.ts`). Plain object literals are accepted but require explicit type annotations.

```ts
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
  timeoutMs?: number; // default limits.observationTimeoutMs (5000)
}

export interface AgentActionDefinition<TIn extends JsonValue, TOut extends JsonValue | void = void> {
  description: string;
  input: AgentSchema<TIn>;
  output?: AgentSchema<Exclude<TOut, void>>;
  /** View actions MUST be "local-state" | "navigation" (plane rule, 01). */
  effect: "local-state" | "navigation";
  idempotent?: boolean;       // default false
  reversible?: boolean;       // default true (see defaults table in 01)
  confirmation?: "never" | "optional" | "required"; // default "never"
  audit?: "none" | "metadata" | "full";             // default "metadata"
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  /**
   * Input-aware validation beyond the schema (e.g. "ids must exist in the
   * current dataset"). Return void to pass; return/throw PreconditionFailure
   * to fail with PRECONDITION_FAILED.
   */
  precondition?(input: TIn, ctx: AgentReadContext): void | PreconditionFailure;
  /**
   * TOut is inferred from `output` only (NoInfer, TS ≥5.4): the schema is the
   * source of truth and the handler's return is checked against it, never the
   * other way around (verified in prototypes/api-typecheck.ts).
   */
  execute(input: TIn, ctx: AgentActionContext): NoInfer<TOut> | Promise<NoInfer<TOut>>;
  policies?: AgentPolicy[];
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;         // default limits.actionTimeoutMs (10000)
}

export interface PreconditionFailure {
  message: string;                       // agent-safe
  details?: Record<string, JsonValue>;   // agent-safe
}

/** Identity helpers that fix generics for record-literal authoring. */
export function observation<TOut extends JsonValue>(
  def: AgentObservationDefinition<TOut>,
): AgentObservationDefinition<TOut>;
export function action<TIn extends JsonValue, TOut extends JsonValue | void = void>(
  def: AgentActionDefinition<TIn, TOut>,
): AgentActionDefinition<TIn, TOut>;
export function defineAgentComponent(def: AgentComponentDefinition): AgentComponentDefinition;
```

### Handler contexts

```ts
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
```

---

## Registry

```ts
export interface RegistryOptions {
  /** "development" | "production" | "test". Default: "production". */
  environment?: AgentEnvironment;
  /**
   * Host context provider, called lazily per policy evaluation / handler
   * context. MUST be synchronous and cheap (read from stores, don't fetch).
   */
  context?: () => Record<string, unknown>;
  /** Global policies, outermost layer of every chain. */
  policies?: AgentPolicy[];
  /** Audit sink; default: bounded in-memory sink (+ console in development). */
  audit?: AuditSink;
  /** Guard invoked before accepting a registration (trust filtering, 06). */
  onRegister?: (candidate: RegistrationCandidate) => "accept" | "reject";
  /** Collision handling for duplicate (type, instanceId). Default "reject". */
  onDuplicateInstance?: "reject" | "replace";
  /** Suffix-collision diagnostics vs known domain ids. Default "warn". */
  duplicateSuffixPolicy?: "off" | "warn" | "error";
  /** Route descriptor for snapshots (host wires its router here). */
  route?: () => AgentRouteInfo | undefined;
  limits?: Partial<AgentSurfaceLimits>;
  /** Compiler-generated source of truth. Runtime-mandatory. */
  authority?: CapabilityAuthority;
}

export interface AgentRouteInfo { path: string; params?: Record<string, string>; }

export function createAgentSurfaceRegistry(options?: RegistryOptions): AgentSurfaceRegistry;

export interface AgentSurfaceRegistry {
  readonly surfaceId: string;                    // "srf_" + random, per instance
  register(definition: AgentComponentDefinition): AgentRegistrationHandle;
  snapshot(context?: SnapshotContext): AgentSurfaceSnapshot;      // synchronous
  invoke(request: AgentInvocation, options?: InvokeOptions): Promise<AgentInvocationResult>;
  subscribe(listener: (event: AgentSurfaceEvent) => void): Unsubscribe;
  /** Confirmation lifecycle — see 06 and #confirmation-api below. */
  confirmations: ConfirmationController;
  /** Register a domain-procedure executor (installed by @agent-surface/orpc). */
  setProcedureExecutor(executor: AgentProcedureExecutor | undefined): void;
  getVersion(): string;
  /** Tears down: aborts in-flight invocations (CANCELLED), clears listeners. */
  dispose(): void;
}

export type Unsubscribe = () => void;
```

`register` never throws in production for *runtime* conditions (duplicate instance, guard rejection): it returns a **dead handle** (`handle.status === "rejected"`), emits `component-rejected`, and logs. It DOES throw `AgentSurfaceDefinitionError` — in every environment — for *structural* defects the author must fix: invalid id grammar, unsupported schema keywords, plane violations, oversize descriptions. Rationale: structural defects are deterministic bugs; runtime collisions can be transient races (route-transition overlap) that must not crash production. See D4.

---

## Registration lifecycle

```ts
export interface AgentRegistrationHandle {
  readonly registrationId: string;          // "reg_" + monotonic + random
  readonly status: "active" | "rejected" | "unregistered";
  /**
   * Push dynamic updates. ONLY the listed fields are updatable; anything
   * structural (ids, names, schemas, descriptions, effects, policies)
   * requires unregister + register (⇒ a new registrationId). See D2.
   */
  update(patch: {
    enabled?: boolean;
    /** Per-capability availability overrides pushed eagerly (event-driven adapters). */
    availability?: Record<string, { available: boolean; reason?: string }>;
  }): void;
  /** Bumps the surface version without changing anything (rarely needed). */
  invalidate(): void;
  unregister(): void;
}
```

Lifecycle rules (normative):

1. **Mount → register.** A registration is live immediately and appears in the next snapshot; `surface-changed` fires with the new version.
2. **Structural immutability per registration (D2).** The descriptor (types, names, schemas, descriptions, effect metadata, policy chain shape) is frozen at `register()`. This is what makes `registrationId` a meaningful staleness token: an agent that discovered `reg_x` knows *exactly* what `reg_x` can do. Handlers are NOT part of the frozen descriptor — see next rule.
3. **Handlers are read through a live reference.** `execute`/`read`/`when`/`bind` are read at invocation time from the definition object's current state, enabling the React latest-ref pattern (D3, [React API](04-react-api.md#handler-freshness-d3--why-there-is-no-dependency-array)). Swapping handler closures neither bumps the version nor changes identity.
4. **Unmount → unregister.** All capabilities disappear from subsequent snapshots; in-flight invocations for the registration are aborted and settle `COMPONENT_UNMOUNTED` (unless the handler already resolved — first settle wins). Exception (D23): in-flight `navigation`-effect invocations are *not* settled by unregistration; they settle on handler settlement/timeout/cancel ([§concurrency](#concurrency-timeouts-cancellation)). The registry MUST NOT retain executable references after unregistration; the tombstone keeps only ids and timestamps (a pending navigation settlement holds the already-running handler promise, not a re-invocable reference).
5. **Tombstones.** Unregistered registrationIds are remembered in a bounded structure (default 100 entries / 5 min) so late invocations get the precise `COMPONENT_UNMOUNTED` instead of the generic `CAPABILITY_NOT_FOUND`.
6. **Post-unregister calls** on the handle are no-ops that warn in development.
7. **`dispose()`** unregisters everything, settles in-flight invocations as `CANCELLED`, resolves pending confirmations as expired, and drops listeners.

### Collisions (D4)

- **Component key** = `(plane, type, instanceId)`. A second live registration with the same key is handled per `onDuplicateInstance`:
  - `"reject"` (default): the newcomer gets a dead handle + `component-rejected` event + dev console.error. First-wins keeps behavior deterministic during route-transition overlaps.
  - `"replace"`: the previous registration is unregistered (its invocations abort as `COMPONENT_UNMOUNTED`), then the newcomer registers. For apps with exit animations that keep the old page mounted.
- **Capability key** = component key + capability name; duplicates inside one definition are structural (`AgentSurfaceDefinitionError`, always thrown).
- **Cross-plane suffix collision**: registering `view:X.Y` when `domain:X.Y` is a known procedure id (executor manifest loaded) triggers `duplicateSuffixPolicy` (default `"warn"`: console + `collision-suspected` event). This is a heuristic lint, not a security control.

---

## Availability

A capability's effective availability for a consumer is computed as:

```text
available :=
      registration.status === "active"
  AND component.enabled !== false
  AND pushed availability override (if any) is not {available:false}
  AND when() !== false                       // evaluated lazily, may throw ⇒ unavailable("when-error")
  AND every policy discovery decision === "expose"
```

- `when()` is evaluated at **snapshot** time and re-evaluated at **invocation** time (phase 3). It MUST be synchronous, cheap, and exception-safe; a throwing `when` counts as `false` (dev warning).
- Lazily-evaluated `when` changes do **not** bump `surfaceVersion` (nobody was notified). Pushed changes — `update({availability})`, `update({enabled})` — DO bump it. Framework adapters are responsible for pushing: the React package re-evaluates `when` per render and pushes on change, so in React apps availability is effectively event-driven. Pure-core users either push or accept snapshot-time freshness. This split is deliberate; see D1 remarks.
- Policy `hide` decisions remove the capability from the snapshot entirely (see [Policies & Security](06-policies-and-security.md)); availability as defined above only produces `available`/`unavailable`.

---

## Versioning

- `surfaceId`: `"srf_" + 22 random base62 chars`, minted per registry. Distinguishes page loads / realms.
- `surfaceVersion`: unsigned integer starting at `"0"` (empty registry), incremented by 1 for every surface-affecting mutation: register, unregister, replace, `update({enabled|availability})`, `invalidate()`, procedure-binding structural change. Serialized as a decimal string; consumers MUST treat it as opaque and only compare equality (ordering is an implementation detail they MAY exploit for logging).
- Handler swaps, `when()` drift, and bound-value changes do NOT bump the version (they alter neither the catalog nor identities).
- `(surfaceId, surfaceVersion)` globally identifies a surface state. A consumer presenting a `surfaceVersion` under a different `surfaceId` is stale by definition (page reloaded): resolution phase treats it exactly like a registration mismatch → `STALE_CAPABILITY`.

**Staleness enforcement (Draft):**

- If `invocation.registrationId` is set and differs from the live registration for the target → `STALE_CAPABILITY` (details: `{ liveRegistrationId }` so a consumer that *knows* the capability is equivalent can re-discover cheaply).
- If it matches a tombstone → `COMPONENT_UNMOUNTED`.
- If `invocation.surfaceVersion` is set and differs from current, the invocation still proceeds (global version changes constantly for unrelated reasons), **except** when the target capability's effect is `destructive` or `external-side-effect`, where the registry MUST reject with `STALE_CAPABILITY` (`details.reason: "surface-version-mismatch"`). Adapters SHOULD always send `registrationId` (precise) and MAY send `surfaceVersion` (belt-and-braces for dangerous calls).
- Every result carries the current `surfaceVersion`; adapters SHOULD re-snapshot when it moved.

---

## Snapshot

```ts
export interface SnapshotContext {
  consumer?: AgentConsumer;              // default: {"id":"anonymous","kind":"embedded"}
  /** Component-type prefixes to include, e.g. ["devices"]. Default: all. */
  scope?: string[];
  /** Include visible-disabled capabilities. Default true. */
  includeUnavailable?: boolean;
  /** [Experimental] Truncation budget; see below. */
  budget?: { maxComponents?: number; maxBytes?: number };
}

export interface AgentConsumer {
  id: string;
  kind: "embedded" | "webmcp" | "mcp-bridge" | "test" | "other";
  /** Free-form grant strings interpreted by host policies. */
  grants?: string[];
}

export interface AgentSurfaceSnapshot {
  surfaceId: string;
  surfaceVersion: string;
  capturedAt: string;                    // ISO-8601
  route?: AgentRouteInfo;
  components: AgentComponentDescriptor[];
  /** Domain references, top-level (planes are not nested into each other). */
  procedures: AgentProcedureDescriptor[];
  /** [Experimental] Present iff a budget truncated the snapshot. */
  truncated?: { droppedComponents: number };
  /** [Experimental] Present iff a scope floor refused requested prefixes (D31). */
  scopeRejected?: { prefixes: string[] };
}

export interface AgentComponentDescriptor {
  type: string;
  instanceId: string;
  registrationId: string;
  description: string;
  parent?: { type: string; instanceId: string };
  meta?: Record<string, JsonValue>;
  observations: AgentObservationDescriptor[];
  actions: AgentActionDescriptor[];
}

export interface AgentObservationDescriptor {
  capabilityId: string;                  // "view:devices.table.readState"
  name: string;                          // "readState"
  description: string;
  outputSchema: JsonSchema;
  available: boolean;
  unavailableReason?: string;
  meta?: Record<string, JsonValue>;
}

export interface AgentActionDescriptor {
  capabilityId: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: "local-state" | "navigation";
  idempotent: boolean;
  reversible: boolean;
  confirmation: "never" | "optional" | "required";
  available: boolean;
  unavailableReason?: string;
  meta?: Record<string, JsonValue>;
}
```

(`AgentProcedureDescriptor` is defined in [oRPC integration](05-orpc-integration.md#snapshot-descriptor); it lives at the snapshot top level with a `context` link back to the component that registered it, keeping the two planes visually and structurally distinct. This intentionally diverges from an early sketch that nested domain refs inside components — nesting conflated the planes.)

Snapshot semantics (normative):

- `snapshot()` is **synchronous and side-effect free**: it MUST NOT run `read()` handlers, MUST NOT await, and discovery-time policy evaluation MUST be synchronous (async authority checks belong to invocation). This is why the shape is a catalog, not a state dump (D5).
- Descriptors are deep-frozen plain JSON; `internal` metadata MUST NOT appear anywhere in a snapshot (tested).
- Ordering: components sorted by (`priority` desc, `type`, `instanceId`) — deterministic, never DOM- or mount-order-dependent.
- **Stable and volatile text are separate** (D28). A procedure reference's contextual `describe()` output is `contextualNote`; `description` is the manifest text and never contains it. There is one composition, so no consumer has to parse a string it did not write. The 0.3–0.4 compatibility flags that could merge them were removed in 0.5.
- Shape: **flat with `parent` links** (D6-shape). Flat is trivial to serialize, diff, and budget; hierarchy-aware consumers can rebuild the tree from `parent`. A nested/query-navigable surface was considered and rejected: it adds traversal API surface with no consumer that needs it yet.
- Budgets (**Experimental**): when set, components are dropped lowest-priority-first after the cap; the snapshot says so via `truncated`. No silent truncation, ever.
- `scopeRejected` (**Experimental**) is the same rule applied to the other way a payload can be smaller than it looks (D31): it is set by the *adapter*, never by `snapshot()`, which knows nothing of the scope floor it would be intersecting against. See [Adapters §meta-tools-mode](09-adapters.md#meta-tools-mode).

### `explainSurface()` — developer projection

> [!NOTE]
> **Status: Draft** (D33). Separate entry point: `@agent-surface/core/explain`. Deliberately **not** exported from the package root — see [Policies & Security §explain is never agent-facing](06-policies-and-security.md#explain-is-never-agent-facing) before wiring it anywhere.

```ts
import { explainSurface } from "@agent-surface/core/explain";

explainSurface(registry: AgentSurfaceRegistry, ctx?: SnapshotContext): SurfaceExplanation
```

The snapshot answers *what may this agent call*. It bakes policy outcomes, so a `hide` deletes the capability and the reason together. The explanation answers *why*, over the same registry and the same context:

```ts
interface CapabilityExplanation {
  capabilityId: string;
  kind: "observation" | "action" | "procedure";
  plane: "view" | "domain";
  description: string;                      // hidden capabilities have no snapshot entry to read it from
  registrationId: string;
  component: { type: string; instanceId: string };
  outcome: "expose" | "disable" | "hide";   // "hide" ⇒ absent from snapshot()
  reason?: string;
  policies: Array<{
    name: string;                           // AgentPolicy.name
    scope: "registry" | "component" | "capability";
    phases: Array<"discovery" | "authorize" | "invoke">;
    discovery?: DiscoveryDecision;          // this policy's own vote
    threw?: boolean;                        // onDiscovery threw; evaluateDiscovery failed closed
    confirmationEscalation?: boolean;
  }>;
  availability: { available: boolean; reason?: string };   // `when()`, kept apart from policy
}
```

Semantics (normative):

- It reports **every** capability the registry holds, hidden ones included. `includeUnavailable` and `budget` are ignored: withholding is the one thing an explanation must not do. `scope` and `consumer` are honoured, so it lines up with the snapshot being debugged.
- Its composed outcome MUST equal what `snapshot()` did for the same context (`AS-EXPLAIN-003`). `evaluateDiscovery` short-circuits on the first `hide`, so explain cannot reuse it — it re-runs each `onDiscovery` individually and composes by the same rule. Re-running is safe by contract: discovery policies MUST be synchronous, cheap, and side-effect free ([Policies & Security](06-policies-and-security.md#policy-pipeline)).
- Policy attribution keeps `availability` separate from the policy votes, because *authority hides, state discloses* (D11/D12) and the two failures must not look alike.
- It throws on a registry it did not create, or a disposed one — rather than reporting an empty surface, which is what a missing internals seam would otherwise look like.

---

## Invocation

```ts
export interface AgentInvocation {
  /** Idempotency key. Adapters SHOULD pass their tool-call id. Generated if absent. */
  invocationId?: string;
  capabilityId: string;                  // "view:..." or "domain:..."
  /** Required when >1 live instance of the target component exists. */
  instanceId?: string;
  /** Staleness token from discovery. Adapters SHOULD always send it. */
  registrationId?: string;
  /** Version hint; enforced only for destructive/external effects (see Versioning). */
  surfaceVersion?: string;
  input?: JsonValue;
  /** Evidence from a resolved confirmation (see 06). */
  confirmationId?: string;
}

export interface InvokeOptions {
  consumer?: AgentConsumer;
  signal?: AbortSignal;                  // external cancellation → CANCELLED
  timeoutMs?: number;                    // overrides capability/limits default
}

export type AgentInvocationResult =
  | {
      status: "ok";
      invocationId: string;
      capabilityId: string;
      output?: JsonValue;                // validated against outputSchema if declared
      surfaceVersion: string;            // current version at settle time
      /** Set when the surface changed during execution (agent should re-discover). */
      surfaceChanged?: boolean;
    }
  | {
      status: "error";
      invocationId: string;
      capabilityId: string;
      error: AgentCapabilityErrorPayload;   // see 07-errors.md
      surfaceVersion: string;
      surfaceChanged?: boolean;
    };
```

Semantics:

- The result is a **discriminated union, not an exception**: `invoke` only rejects on programmer misuse (e.g. called after `dispose`). Everything agent-facing — including `CONFIRMATION_REQUIRED` — is a serializable `status: "error"` payload with structured `details` and retry semantics ([Errors](07-errors.md)). `CONFIRMATION_REQUIRED` is a *protocol step*, not a failure; it is encoded as an error so the wire model stays binary.
- Instance resolution: if `instanceId` is omitted and exactly one live instance matches, it is used; zero → `CAPABILITY_NOT_FOUND` (or tombstone/stale variants); more than one → `AMBIGUOUS_INSTANCE` with `details.instances: string[]`.
- The **effective input** is constructed and fully validated at phase 5 — after pre-input authorization (phase 4), before any input-aware policy or the confirmation decision (phase 6). Handlers receive the parsed (possibly defaulted) effective value; input-aware policies receive it as `ctx.effectiveInput` and can never see raw agent input ([Policies & Security §policy-pipeline](06-policies-and-security.md#policy-pipeline), D21).
- Observations are invoked through the same API (`input` omitted); they skip confirmation and the action queue but pass **observation admission** (bounded concurrency, phase 8; D24).
- Pipeline order is fixed and normative — see [Architecture](02-architecture.md#invocation-pipeline-normative-order).

### Invocation identity, idempotency, conflict safety (D14 as corrected by D22)

Provider tool-call ids are not globally unique; identity is therefore **consumer-scoped** and **request-bound** ([Spec Corrections RFC](project/18-spec-corrections-rfc.md#correction-2--consumer-scoped-conflict-safe-invocation-identity-d22-amends-d14)):

```ts
// per registry (surfaceId scopes page lifetimes):
dedupeKey   = consumerKey + " " + invocationId       // consumerKey = kind + ":" + id
fingerprint = fnv1a64(canonicalJson({ capabilityId, registrationId, instanceId,
                                      surfaceVersion, input, confirmationId })) // as issued
```

- Results of **terminal** outcomes are cached per key (default 200 entries / 10 min). Terminal = `ok` and every error **except** `CONFIRMATION_REQUIRED` and `RATE_LIMITED` (expected-retry outcomes; caching them would break the retry). `INVOCATION_CONFLICT` results are never cached either — they describe the collision, not the request.
- Re-invoke with a known in-flight key **and matching fingerprint** returns the same pending promise (join, not re-execute); with a cached terminal key + matching fingerprint, the cached result verbatim. This is what makes transport retries safe.
- Re-invoke with a known key and a **different** fingerprint fails closed: `INVOCATION_CONFLICT` (`retry: "with-changes"` — i.e. use a fresh `invocationId` if the new request is intentional). The stored record is untouched. Reusing an id for a different request can never silently succeed.
- Different consumers may reuse the same provider tool-call id safely (distinct keys); different page loads cannot collide (distinct registries). Anonymous invocations normalize to `embedded:anonymous` — adapters MUST pass a stable per-instance consumer id when more than one consumer addresses the registry ([Adapters §adapter contract](09-adapters.md#adapter-contract)).
- The dedupe window is bounded (`dedupeCacheSize`, `dedupeCacheTtlMs`): an **idempotency window**, not a forever guarantee. An expired key is a new attempt.
- Confirmation retry: reuses the **same** `invocationId` + `confirmationId`; since `CONFIRMATION_REQUIRED` was not cached as terminal, the retry executes (once).

---

## Concurrency, timeouts, cancellation

(D13, D15, D16 — Draft; amended by D23/D24/D25, [Spec Corrections RFC](project/18-spec-corrections-rfc.md))

- **Actions**: serialized per component instance (FIFO). One in-flight + a wait queue of `limits.actionQueueDepth` (default 2). Overflow → `RATE_LIMITED` with `details.reason: "queue-full"`, `retry: "after-delay"`.
- **Observations**: bounded concurrency (D24). Admission gates: `maxConcurrentObservationsPerConsumer` (8) and `maxConcurrentObservationsTotal` (32), independent; a saturated consumer queues FIFO up to `maxQueuedObservationsPerConsumer` (8). Overflow → `RATE_LIMITED {reason: "queue-full", retryAfterMs}`. Observations never consume the action queue; one consumer cannot starve another below its per-consumer allowance beyond the shared global cap. Cancellation/timeout/settlement release slots; disposal drains queues as `CANCELLED`. Observations SHOULD still be synchronous reads.
- **Procedures**: forwarded, and admitted through one group per *procedure identity per referencing registration* — repeat calls of the same domain operation serialize client-side, while a view action on the same component is never blocked by an in-flight domain call. The server still governs real concurrency; this is queueing hygiene, not authority.
- **Concurrency contract (D25, Draft — implemented):**

  ```ts
  export type AgentConcurrency =
    | { mode: "instance"; queueDepth?: number }   // default: one queue per registration
    | { mode: "capability"; queueDepth?: number } // one queue per capability
    | { mode: "key"; key: string; queueDepth?: number }
    | { mode: "parallel"; max: number; queueDepth?: number };
  ```

  Declared per action (`action({concurrency})`) or per procedure reference (binding config). The default remains `{mode:"instance"}` — the safe one: two actions on the same component never interleave. `parallel` requires an integer `max ≥ 1`; unbounded parallelism is not offered, and an invalid group throws `AgentSurfaceDefinitionError` at registration. `queueDepth` overrides `limits.actionQueueDepth` for that group only; overflow is `RATE_LIMITED {reason:"queue-full"}` as everywhere else. Groups are created on demand and dropped when idle, so the runtime holds one entry per *currently contended* group, not per capability ever invoked. Not model-visible: concurrency is runtime behavior, not planning information.
- **Timeouts**: `timeoutMs` per capability, else defaults (observation 5 s, action 10 s, procedure 30 s). On timeout the registry aborts `ctx.signal`, settles `TIMEOUT`, and ignores (but logs) any late handler settlement. JS cannot force-kill the handler; cooperation via `signal` is the contract.
- **External cancellation**: `InvokeOptions.signal` aborted → settle `CANCELLED` (same late-settlement rule).
- **Unmount mid-flight (D16, non-navigation)**: unregistration aborts the registration's in-flight signals; the invocation settles `COMPONENT_UNMOUNTED` unless the handler settled first (first settle wins, the loser is logged as `late-settlement` in audit) — never a hang, never a zombie handler kept alive by the registry.
- **Navigation settlement (D23)**: for actions with `effect: "navigation"`, unregistration MUST NOT settle the invocation — a navigation action's own success routinely unmounts its owner, and unmount timing must not decide the outcome. The invocation settles only on handler settlement (resolve → `ok`; reject with `ctx.signal` aborted → `CANCELLED`, otherwise `EXECUTION_FAILED`), timeout, or external cancel. Unmount **before** dispatch is still `COMPONENT_UNMOUNTED`. Authoring contract: resolve when the host router accepts/commits the transition, reject when it refuses ([Concepts §effects](01-concepts.md#effect-taxonomy), [React API §route-transitions](04-react-api.md)).

---

## Events

```ts
export type AgentSurfaceEvent =
  | { type: "surface-changed"; surfaceVersion: string }           // coalesced per microtask
  | { type: "component-registered"; registrationId: string; componentType: string; instanceId: string }
  | { type: "component-unregistered"; registrationId: string; componentType: string; instanceId: string }
  | { type: "component-rejected"; componentType: string; instanceId: string; reason: "duplicate" | "guard" }
  | { type: "availability-changed"; registrationId: string; capabilityId: string; available: boolean }
  | { type: "collision-suspected"; viewCapabilityId: string; domainProcedureId: string }
  | { type: "invocation-started"; invocationId: string; capabilityId: string; consumerId: string }
  | { type: "invocation-settled"; invocationId: string; capabilityId: string;
      status: "ok" | "error"; code?: AgentCapabilityErrorCode; durationMs: number }
  | { type: "confirmation-requested"; confirmationId: string; capabilityId: string; expiresAt: string }
  | { type: "confirmation-resolved"; confirmationId: string; outcome: "approved" | "denied" | "expired" };
```

Ordering guarantees (D17) are specified in [Architecture](02-architecture.md#concurrency-and-ordering-guarantees): total mutation order, post-mutation dispatch, listener-exception isolation, queued re-entrancy, per-invocation `started` strictly before `settled`, `confirmation-requested` strictly before its `resolved`.

Events are the integration point for audit sinks, adapters (re-snapshot on `surface-changed`), and confirmation UIs.

---

## Confirmation API

The full protocol (evidence binding, expiry, replay rules, server interplay) is in [Policies & Security](06-policies-and-security.md#confirmation). Core exposes:

```ts
export interface ConfirmationController {
  /** Pending requests, for host UI rendering. */
  pending(): PendingConfirmation[];
  resolve(confirmationId: string, resolution: { approved: boolean; reason?: string }): void;
  /** Resolves when the given confirmation settles (approved/denied/expired). */
  waitFor(confirmationId: string, opts?: { signal?: AbortSignal }): Promise<"approved" | "denied" | "expired">;
  subscribe(listener: (pending: PendingConfirmation[]) => void): Unsubscribe;
}

export interface PendingConfirmation {
  confirmationId: string;                // "cnf_" + random
  capabilityId: string;
  registrationId: string;
  /** Normalized consumer identity: `kind + ":" + id` (D22). */
  consumerKey: string;
  /** Effect of the operation being approved (host dialogs render it). */
  effect: AgentEffect;
  /** Human-readable summary composed from description + effective input. */
  summary: string;
  /** The exact effective input (bound + agent-supplied) being approved. */
  input: JsonValue;
  requestedAt: string;
  expiresAt: string;                     // default TTL 120 s
}
```

---

## Toolset

The provider-neutral projection used by the embedded adapter ([Adapters](09-adapters.md#embedded-toolset-adapter-draft)):

```ts
export interface AgentToolsetOptions {
  consumer: AgentConsumer;
  /**
   * "direct": one tool per capability — provider-native input typing, catalog
   * size linear in the surface. "meta": three fixed tools with lazy discovery —
   * constant tool-block size, one extra round trip before the first act.
   * [Experimental] "meta" only: its verb envelope may change in any release
   * (D29). Default "direct"; selection guide in 09 §choosing-a-mode.
   */
  mode?: "direct" | "meta";
  /**
   * Loop topology (D26). Determines the confirmation-mode default:
   * "embedded" → "wait", "remote" → "two-phase". One of `topology` or
   * `confirmations` MUST be provided; omitting both throws (programmer
   * misuse, every environment) — there is no ambiguous global default.
   */
  topology?: "embedded" | "remote";
  /**
   * "wait": on CONFIRMATION_REQUIRED, await user resolution (up to TTL) and
   * auto-retry, so the model sees one tool call → one final result.
   * "two-phase": surface CONFIRMATION_REQUIRED to the model, which retries.
   * Explicit value overrides the topology default; a remote loop opting into
   * "wait" owns its transport-timeout story (docs/09 §confirmation-topology).
   */
  confirmations?: "wait" | "two-phase";
  /**
   * Component-type prefixes this consumer may discover. D27: a **floor** —
   * in "meta" mode a model-supplied scope narrows it, never widens it.
   * Not an authority boundary (docs/09 §scope-is-discovery-only).
   */
  scope?: string[];
  /**
   * [Experimental] Snapshot truncation budget for `surface_discover`.
   * "meta" mode only; throws in "direct" mode, where truncation would drop
   * tools with no `truncated` marker for anyone to see.
   */
  budget?: { maxComponents?: number; maxBytes?: number };
}

export interface AgentTool {
  /** Wire-safe name (see 09 §wire-names), ≤ 64 chars, unique in this catalog. */
  name: string;
  /**
   * Plane + effect + confirmation prefix, then the authored description.
   * Contains NO live state (D28) — safe in a provider tool block with prefix
   * caching across steps.
   */
  description: string;
  inputSchema: JsonSchema;
  /**
   * Volatile: re-derived on every snapshot. Hosts render this OUTSIDE the tool
   * block (e.g. a trailing system message) so availability stays honest without
   * invalidating the cached prefix (D28).
   */
  state: {
    available: boolean;
    unavailableReason?: string;
    /** Live text contributed by a contextual binding's describe(). */
    note?: string;
  };
  execute(input: JsonValue, call: { toolCallId?: string }): Promise<AgentInvocationResult>;
}

export interface AgentToolset {
  tools(): AgentTool[];                  // recomputed per surface version
  /**
   * wireName → canonical capability id, for the catalog tools() last built.
   * Authoritative: shortened names are not decodable by string surgery, so a
   * host MUST consult this rather than reversing names itself (D30). Empty in
   * "meta" mode, whose three tool names are not capability ids.
   */
  wireNameMap(): ReadonlyMap<string, string>;
  /**
   * Fires when tools() would return a different catalog — including a change
   * confined to `state`, so a host re-rendering its state block still hears
   * about an availability flip that leaves the definitions byte-identical.
   * Never fires in "meta" mode: the 3-tool catalog is constant, and agents
   * re-discover by comparing `surfaceVersion` (docs/09 §meta-tools-mode).
   */
  subscribe(listener: (tools: AgentTool[]) => void): Unsubscribe;
  dispose(): void;
}

export function createAgentToolset(
  registry: AgentSurfaceRegistry,
  options: AgentToolsetOptions,
): AgentToolset;
```

`execute` fills `invocationId` from `toolCallId` (idempotent transport retries), attaches `registrationId` + `surfaceVersion` from the catalog it was built from, and never throws — it returns the result envelope for the host to format for its provider.

---

## Limits and defaults

```ts
export interface AgentSurfaceLimits {
  maxComponentDescription: number;   // 500 chars
  maxCapabilityDescription: number;  // 300 chars
  maxMetaBytes: number;              // 2048
  maxOutputBytes: number;            // 32_768
  maxSchemaBytes: number;            // 16_384
  maxSchemaDepth: number;            // 8
  observationTimeoutMs: number;      // 5_000
  actionTimeoutMs: number;           // 10_000
  procedureTimeoutMs: number;        // 30_000
  actionQueueDepth: number;          // 2
  maxConcurrentObservationsPerConsumer: number; // 8   (D24)
  maxConcurrentObservationsTotal: number;       // 32  (D24)
  maxQueuedObservationsPerConsumer: number;     // 8   (D24)
  dedupeCacheSize: number;           // 200 entries
  dedupeCacheTtlMs: number;          // 600_000
  tombstoneSize: number;             // 100 entries
  tombstoneTtlMs: number;            // 300_000
  confirmationTtlMs: number;         // 120_000
  maxPendingConfirmations: number;   // 32  (D24; overflow fails RATE_LIMITED, no record created)
}
```

All defaults are overridable via `RegistryOptions.limits`. Implementations MUST enforce every limit and MUST make violations diagnosable (typed error or dev throw), never silent.
