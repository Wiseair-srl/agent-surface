import type {
  AgentConcurrency,
  AgentConsumer,
  AgentEnvironment,
  AgentProcedureEffect,
  AgentRouteInfo,
  AgentSurfaceLimits,
  JsonSchema,
  JsonValue,
} from "./types.js";
import type {
  AgentComponentDefinition,
  AgentProcedureBinding,
  AgentProcedureExecutor,
} from "./definition.js";
import type { AgentSchema } from "./schema.js";
import type { AgentPolicy, AgentPolicyContext } from "./policy.js";
import type { AgentCapabilityErrorPayload } from "./errors.js";
import type { AgentSurfaceEvent, EventDispatcher } from "./events.js";
import type { AuditEvent, AuditSink } from "./audit.js";
import type { ConfirmationStore } from "./confirmation.js";
import type { AgentInvocationResult } from "./invocation-types.js";
import { formatViewCapabilityId } from "./ids.js";
import { jsonClone } from "./utils.js";

export type ConfirmationLevel = "never" | "optional" | "required";
export type AuditLevel = "none" | "metadata" | "full";

export interface ObservationRuntime {
  kind: "observation";
  name: string;
  capabilityId: string;
  description: string;
  outputSchema: AgentSchema<any>;
  jsonSchema: JsonSchema;
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
  policies: AgentPolicy[];
  auditLevel: AuditLevel;
}

export interface ActionRuntime {
  kind: "action";
  name: string;
  capabilityId: string;
  description: string;
  inputSchema: AgentSchema<any>;
  inputJsonSchema: JsonSchema;
  outputSchema?: AgentSchema<any>;
  outputJsonSchema?: JsonSchema;
  effect: "local-state" | "navigation";
  idempotent: boolean;
  reversible: boolean;
  confirmation: ConfirmationLevel;
  auditLevel: AuditLevel;
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
  policies: AgentPolicy[];
  concurrency?: AgentConcurrency;
}

export interface ProcedureRuntime {
  kind: "procedure";
  binding: AgentProcedureBinding;
  capabilityId: string; // "domain:" + path
  path: string;
  effect: AgentProcedureEffect;
  requiresApproval: boolean;
  baseDescription: string;
  fullInputSchema: JsonSchema;
  reducedInputSchema: JsonSchema;
  outputJsonSchema?: JsonSchema;
  boundKeys: string[];
  lockedKeys: string[];
  overridableKeys: Set<string>;
  confirmationFloor: ConfirmationLevel;
  idempotent: boolean;
  auditLevel: AuditLevel;
  meta?: Record<string, JsonValue>;
  policies: AgentPolicy[];
  contextLink?: { type: string; instanceId: string };
  concurrency?: AgentConcurrency;
}

export interface InFlightEntry {
  /**
   * Owner unregistered. Default: aborts the handler signal and settles
   * COMPONENT_UNMOUNTED (first settle wins, D16). Navigation-effect entries
   * only abort the signal — the invocation settles on handler settlement,
   * timeout, or external cancel (D23).
   */
  onUnregister(): void;
  /** Registry disposed: always aborts and settles CANCELLED. */
  onDispose(): void;
}

export interface InternalRegistration {
  id: string;
  key: string; // `${type}\u0000${instanceId}`
  type: string;
  instanceId: string;
  description: string;
  parent?: { type: string; instanceId: string };
  meta?: Record<string, JsonValue>;
  internal: Readonly<Record<string, unknown>>;
  origin: string;
  priority: number;
  /** Live definition object: handlers/when are read through it (D3). */
  definition: AgentComponentDefinition;
  componentPolicies: AgentPolicy[];
  observations: Map<string, ObservationRuntime>;
  actions: Map<string, ActionRuntime>;
  procedures: ProcedureRuntime[];
  /** Procedure-only registrations never appear in snapshot.components. */
  procedureOnly: boolean;
  status: "active" | "unregistered";
  enabled: boolean;
  availabilityOverrides: Map<string, { available: boolean; reason?: string }>;
  inFlight: Set<InFlightEntry>;
  /**
   * Concurrency groups (D25), created lazily and deleted when they fall idle,
   * so the map is bounded by the number of *currently contended* groups rather
   * than by the number of capabilities ever invoked.
   */
  concurrencyGroups: Map<string, ConcurrencyGroup>;
}

/** One FIFO admission group. `max` is 1 for every mode except `parallel`. */
export interface ConcurrencyGroup {
  running: number;
  max: number;
  depth: number;
  waiting: Array<() => void>;
}

export interface Tombstone {
  registrationId: string;
  type: string;
  instanceId: string;
  capabilityIds: Set<string>;
  expiresAt: number;
}

/** Dedupe entries carry the request fingerprint (D22): join/return only on
 * a match; a mismatch fails INVOCATION_CONFLICT without touching the entry. */
export type DedupeEntry =
  | { kind: "inflight"; fingerprint: string; promise: Promise<AgentInvocationResult> }
  | { kind: "terminal"; fingerprint: string; result: AgentInvocationResult; expiresAt: number };

/** Bounded observation admission state (D24). `waiting` is arrival-ordered;
 * a release wakes the first waiter whose consumer is under its cap. */
export interface ObservationAdmission {
  total: number;
  perConsumer: Map<string, number>;
  waiting: Array<{ consumerKey: string; admit: (admitted: boolean) => void }>;
}

export interface RegistryInternals {
  environment: AgentEnvironment;
  limits: AgentSurfaceLimits;
  /** D28 compatibility: fold a procedure's contextual note into `description`. */
  mergesContextualNote: boolean;
  surfaceId: string;
  version: number;
  registrations: Map<string, InternalRegistration>;
  byKey: Map<string, string>;
  tombstones: Map<string, Tombstone>;
  /** Keyed by `${consumerKey} ${invocationId}` (D22). */
  dedupe: Map<string, DedupeEntry>;
  observationAdmission: ObservationAdmission;
  dispatcher: EventDispatcher;
  confirmations: ConfirmationStore;
  executor: AgentProcedureExecutor | undefined;
  disposed: boolean;
  registryPolicies: AgentPolicy[];
  auditSink: AuditSink | undefined;
  contextFn: (() => Record<string, unknown>) | undefined;
  routeFn: (() => AgentRouteInfo | undefined) | undefined;
  now: () => number;
  bumpVersion(): void;
  emit(event: AgentSurfaceEvent): void;
  recordAudit(event: Omit<AuditEvent, "at">): void;
  host(): Record<string, unknown>;
  devWarn(...args: unknown[]): void;
  devError(...args: unknown[]): void;
}

/** Marker for defects that must throw out of invoke() in development. */
export class DevDefectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSurfaceDevDefectError";
  }
}

export function componentKey(type: string, instanceId: string): string {
  return `${type}\u0000${instanceId}`;
}

const CONFIRMATION_RANK: Record<ConfirmationLevel, number> = {
  never: 0,
  optional: 1,
  required: 2,
};

export function maxConfirmation(...levels: ConfirmationLevel[]): ConfirmationLevel {
  return levels.reduce((acc, l) => (CONFIRMATION_RANK[l] > CONFIRMATION_RANK[acc] ? l : acc), "never");
}

export function defaultConfirmationFor(effect: AgentProcedureEffect): ConfirmationLevel {
  switch (effect) {
    case "server-query":
      return "never";
    case "server-mutation":
      return "optional";
    case "external-side-effect":
    case "destructive":
      return "required";
  }
}

export function defaultAuditFor(effect: AgentProcedureEffect): AuditLevel {
  return effect === "external-side-effect" || effect === "destructive" ? "full" : "metadata";
}

let registrationCounter = 0;
export function nextRegistrationId(random: () => string): string {
  registrationCounter += 1;
  return `reg_${registrationCounter.toString(36).padStart(4, "0")}${random()}`;
}

/** Copies the structural descriptor out of a definition (frozen per D2). */
export function normalizeRegistration(
  def: AgentComponentDefinition,
  id: string,
): InternalRegistration {
  const instanceId = def.instanceId ?? "default";
  const observations = new Map<string, ObservationRuntime>();
  for (const [name, obs] of Object.entries(def.observations ?? {})) {
    observations.set(name, {
      kind: "observation",
      name,
      capabilityId: formatViewCapabilityId(def.type, name),
      description: obs.description,
      outputSchema: obs.output,
      jsonSchema: jsonClone(obs.output.jsonSchema),
      meta: obs.meta ? jsonClone(obs.meta) : undefined,
      timeoutMs: obs.timeoutMs,
      policies: [...(obs.policies ?? [])],
      auditLevel: "none",
    });
  }
  const actions = new Map<string, ActionRuntime>();
  for (const [name, act] of Object.entries(def.actions ?? {})) {
    actions.set(name, {
      kind: "action",
      name,
      capabilityId: formatViewCapabilityId(def.type, name),
      description: act.description,
      inputSchema: act.input,
      inputJsonSchema: jsonClone(act.input.jsonSchema),
      outputSchema: act.output,
      outputJsonSchema: act.output ? jsonClone(act.output.jsonSchema) : undefined,
      effect: act.effect,
      idempotent: act.idempotent ?? false,
      reversible: act.reversible ?? true,
      confirmation: act.confirmation ?? "never",
      auditLevel: act.audit ?? "metadata",
      meta: act.meta ? jsonClone(act.meta) : undefined,
      timeoutMs: act.timeoutMs,
      policies: [...(act.policies ?? [])],
      concurrency: act.concurrency,
    });
  }
  const hasView = observations.size > 0 || actions.size > 0;
  const procedures: ProcedureRuntime[] = (def.procedures ?? []).map((binding) => {
    const boundKeys = [...binding.boundKeys];
    const overridable = new Set(binding.config.overridableFields ?? []);
    const lockedKeys = binding.lockedKeys
      ? [...binding.lockedKeys]
      : boundKeys.filter((k) => !overridable.has(k));
    const effect = binding.ref.effect;
    return {
      kind: "procedure",
      binding,
      capabilityId: binding.ref.id,
      path: binding.ref.path,
      effect,
      requiresApproval: binding.ref.requiresApproval === true,
      baseDescription: binding.ref.description,
      fullInputSchema: jsonClone(binding.ref.inputSchema),
      reducedInputSchema: jsonClone(binding.reducedInputSchema),
      outputJsonSchema: binding.ref.outputSchema ? jsonClone(binding.ref.outputSchema) : undefined,
      boundKeys,
      lockedKeys,
      overridableKeys: overridable,
      confirmationFloor: maxConfirmation(
        defaultConfirmationFor(effect),
        binding.config.confirmation ?? "never",
        binding.ref.requiresApproval === true ? "required" : "never",
      ),
      idempotent: effect === "server-query",
      auditLevel: defaultAuditFor(effect),
      meta: binding.config.meta ? jsonClone(binding.config.meta) : undefined,
      policies: [...(binding.config.policies ?? [])],
      contextLink:
        binding.contextLink ?? (hasView ? { type: def.type, instanceId } : undefined),
      concurrency: binding.config.concurrency,
    };
  });

  return {
    id,
    key: componentKey(def.type, instanceId),
    type: def.type,
    instanceId,
    description: def.description,
    parent: def.parent
      ? { type: def.parent.type, instanceId: def.parent.instanceId ?? "default" }
      : undefined,
    meta: def.meta ? jsonClone(def.meta) : undefined,
    internal: Object.freeze({ ...(def.internal ?? {}) }),
    origin: def.origin ?? "first-party",
    priority: def.priority ?? 0,
    definition: def,
    componentPolicies: [...(def.policies ?? [])],
    observations,
    actions,
    procedures,
    procedureOnly: !hasView && procedures.length > 0,
    status: "active",
    enabled: def.enabled !== false,
    availabilityOverrides: new Map(),
    inFlight: new Set(),
    concurrencyGroups: new Map(),
  };
}

/**
 * Resolve the concurrency group for a capability (D25). Actions default to
 * `{mode:"instance"}` — one queue for the whole registration, so unrelated
 * actions on one component cannot interleave. Procedure references default to
 * one group per procedure identity per referencing registration: conservative
 * for repeat calls of the same domain operation, and never coupled to view
 * actions that happen to live on the same component.
 */
export function concurrencyGroupFor(
  cap: ActionRuntime | ProcedureRuntime,
  limits: AgentSurfaceLimits,
): { key: string; max: number; depth: number } {
  const declared: AgentConcurrency | undefined =
    cap.kind === "action" ? cap.concurrency : cap.concurrency;
  const fallbackDepth = limits.actionQueueDepth;
  if (declared === undefined) {
    return cap.kind === "action"
      ? { key: "instance", max: 1, depth: fallbackDepth }
      : { key: `proc:${cap.capabilityId}`, max: 1, depth: fallbackDepth };
  }
  const depth = declared.queueDepth ?? fallbackDepth;
  switch (declared.mode) {
    case "instance":
      return { key: "instance", max: 1, depth };
    case "capability":
      return { key: `cap:${cap.capabilityId}`, max: 1, depth };
    case "key":
      return { key: `key:${declared.key}`, max: 1, depth };
    case "parallel":
      return { key: `par:${cap.capabilityId}`, max: declared.max, depth };
  }
}

export type CapabilityRuntime = ObservationRuntime | ActionRuntime | ProcedureRuntime;

/** Live `when`/`unavailableReason` lookup through the definition (D3). */
function liveAvailabilityHooks(
  reg: InternalRegistration,
  cap: CapabilityRuntime,
): { when?: () => boolean; unavailableReason?: string | (() => string) } {
  if (cap.kind === "observation") {
    const live = reg.definition.observations?.[cap.name];
    return { when: live?.when, unavailableReason: live?.unavailableReason };
  }
  if (cap.kind === "action") {
    const live = reg.definition.actions?.[cap.name];
    return { when: live?.when, unavailableReason: live?.unavailableReason };
  }
  return { when: cap.binding.config.when, unavailableReason: cap.binding.config.unavailableReason };
}

export interface Availability {
  available: boolean;
  reason?: string;
}

/** Availability formula from docs/03 §availability (policies applied separately). */
export function computeAvailability(
  internals: RegistryInternals,
  reg: InternalRegistration,
  cap: CapabilityRuntime,
): Availability {
  if (reg.status !== "active") {
    return { available: false, reason: "component-unregistered" };
  }
  if (!reg.enabled) {
    return { available: false, reason: "component-disabled" };
  }
  const overrideKey = cap.kind === "procedure" ? cap.path : cap.name;
  const override =
    reg.availabilityOverrides.get(overrideKey) ?? reg.availabilityOverrides.get(cap.capabilityId);
  if (override && override.available === false) {
    return { available: false, reason: override.reason ?? "unavailable" };
  }
  const hooks = liveAvailabilityHooks(reg, cap);
  if (hooks.when) {
    let result: boolean;
    try {
      result = hooks.when() !== false;
    } catch (err) {
      internals.devWarn(
        `[agent-surface] when() threw for ${cap.capabilityId}; treating as unavailable`,
        err,
      );
      return { available: false, reason: "when-error" };
    }
    if (!result) {
      let reason = "Currently unavailable";
      const ur = hooks.unavailableReason;
      try {
        if (typeof ur === "function") reason = ur();
        else if (typeof ur === "string") reason = ur;
      } catch {
        /* keep fallback reason */
      }
      return { available: false, reason };
    }
  }
  return { available: true };
}

export function policiesFor(
  internals: RegistryInternals,
  reg: InternalRegistration,
  cap: CapabilityRuntime,
): AgentPolicy[] {
  return [...internals.registryPolicies, ...reg.componentPolicies, ...cap.policies];
}

export function buildPolicyContext(
  internals: RegistryInternals,
  reg: InternalRegistration,
  cap: CapabilityRuntime,
  consumer: AgentConsumer,
  host: Record<string, unknown>,
): AgentPolicyContext {
  return {
    capabilityId: cap.capabilityId,
    plane: cap.kind === "procedure" ? "domain" : "view",
    kind: cap.kind,
    effect: cap.kind === "observation" ? "read" : cap.effect,
    registrationId: reg.id,
    consumer,
    host,
    meta: { component: reg.meta, capability: cap.meta },
    internal: reg.internal,
    environment: internals.environment,
    now: () => internals.now(),
  };
}

/** Runtime-normalized consumer identity (D22): the invocation namespace. */
export function consumerKeyOf(consumer: AgentConsumer): string {
  return `${consumer.kind}:${consumer.id}`;
}

export function pruneTombstones(internals: RegistryInternals): void {
  const now = internals.now();
  for (const [id, tomb] of internals.tombstones) {
    if (tomb.expiresAt <= now) internals.tombstones.delete(id);
  }
  while (internals.tombstones.size > internals.limits.tombstoneSize) {
    const oldest = internals.tombstones.keys().next().value;
    if (oldest === undefined) break;
    internals.tombstones.delete(oldest);
  }
}

export function addTombstone(internals: RegistryInternals, reg: InternalRegistration): void {
  const capabilityIds = new Set<string>();
  for (const obs of reg.observations.values()) capabilityIds.add(obs.capabilityId);
  for (const act of reg.actions.values()) capabilityIds.add(act.capabilityId);
  for (const proc of reg.procedures) capabilityIds.add(proc.capabilityId);
  internals.tombstones.set(reg.id, {
    registrationId: reg.id,
    type: reg.type,
    instanceId: reg.instanceId,
    capabilityIds,
    expiresAt: internals.now() + internals.limits.tombstoneTtlMs,
  });
  pruneTombstones(internals);
}
