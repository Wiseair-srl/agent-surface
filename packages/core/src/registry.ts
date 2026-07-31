import type {
  AgentEnvironment,
  AgentRouteInfo,
  AgentSurfaceLimits,
} from "./types.js";
import { DEFAULT_LIMITS, type Unsubscribe } from "./types.js";
import type {
  AgentComponentDefinition,
  AgentProcedureExecutor,
} from "./definition.js";
import { validateComponentDefinition } from "./definition.js";
import type { AgentPolicy } from "./policy.js";
import type { AuditSink, AuditEvent } from "./audit.js";
import { consoleAuditSink, memoryAuditSink, safeRecord } from "./audit.js";
import { EventDispatcher, type AgentSurfaceEvent } from "./events.js";
import { ConfirmationStore, type ConfirmationController } from "./confirmation.js";
import type { AgentInvocation, AgentInvocationResult, InvokeOptions } from "./invocation-types.js";
import { drainObservationQueues, performInvoke } from "./invoke.js";
import { createSnapshot, type AgentSurfaceSnapshot, type SnapshotContext } from "./snapshot.js";
import {
  DEV_WARN,
  addTombstone,
  componentKey,
  nextRegistrationId,
  normalizeRegistration,
  type InternalRegistration,
  type RegistryInternals,
} from "./internal.js";
import { AgentSurfaceDefinitionError } from "./errors.js";
import { formatViewCapabilityId } from "./ids.js";
import { randomBase62 } from "./utils.js";

export interface RegistrationCandidate {
  definition: AgentComponentDefinition; // includes origin (default "first-party")
  stack?: string; // dev-mode capture for diagnostics
}

export interface RegistryOptions {
  /** "development" | "production" | "test". Default: "production". */
  environment?: AgentEnvironment;
  /** Host context provider. MUST be synchronous and cheap. */
  context?: () => Record<string, unknown>;
  /** Global policies, outermost layer of every chain. */
  policies?: AgentPolicy[];
  /** Audit sink; default: bounded in-memory sink (+ console in development). */
  audit?: AuditSink;
  /** Guard invoked before accepting a registration (trust filtering, docs/06). */
  onRegister?: (candidate: RegistrationCandidate) => "accept" | "reject";
  /** Collision handling for duplicate (type, instanceId). Default "reject". */
  onDuplicateInstance?: "reject" | "replace";
  /** Suffix-collision diagnostics vs known domain ids. Default "warn". */
  duplicateSuffixPolicy?: "off" | "warn" | "error";
  /** Route descriptor for snapshots (host wires its router here). */
  route?: () => AgentRouteInfo | undefined;
  limits?: Partial<AgentSurfaceLimits>;
  /** Injectable clock (docs/08 determinism); default Date.now. */
  now?: () => number;
}

export interface AgentRegistrationHandle {
  readonly registrationId: string; // "reg_" + monotonic + random
  readonly status: "active" | "rejected" | "unregistered";
  /** Push dynamic updates; only these fields are updatable (D2). */
  update(patch: {
    enabled?: boolean;
    availability?: Record<string, { available: boolean; reason?: string }>;
  }): void;
  /** Bumps the surface version without changing anything. */
  invalidate(): void;
  unregister(): void;
}

export interface AgentSurfaceRegistry {
  readonly surfaceId: string; // "srf_" + random, per instance
  register(definition: AgentComponentDefinition): AgentRegistrationHandle;
  snapshot(context?: SnapshotContext): AgentSurfaceSnapshot; // synchronous
  invoke(request: AgentInvocation, options?: InvokeOptions): Promise<AgentInvocationResult>;
  subscribe(listener: (event: AgentSurfaceEvent) => void): Unsubscribe;
  confirmations: ConfirmationController;
  /** Register a domain-procedure executor (installed by @agent-surface/orpc). */
  setProcedureExecutor(executor: AgentProcedureExecutor | undefined): void;
  getVersion(): string;
  /** Tears down: aborts in-flight invocations (CANCELLED), clears listeners. */
  dispose(): void;
}

export function createAgentSurfaceRegistry(options?: RegistryOptions): AgentSurfaceRegistry {
  const environment = options?.environment ?? "production";
  const limits: AgentSurfaceLimits = { ...DEFAULT_LIMITS, ...(options?.limits ?? {}) };
  const now = options?.now ?? (() => Date.now());
  const auditSink: AuditSink =
    options?.audit ??
    (environment === "development"
      ? combineSinks(memoryAuditSink(), consoleAuditSink())
      : memoryAuditSink());

  let surfaceChangedScheduled = false;

  const dispatcher = new EventDispatcher((err) => {
    if (environment === "development") {
      // eslint-disable-next-line no-console
      console.error("[agent-surface] event listener threw", err);
    }
  });

  const internals: RegistryInternals = {
    environment,
    limits,
    surfaceId: `srf_${randomBase62(22)}`,
    version: 0,
    registrations: new Map(),
    byKey: new Map(),
    tombstones: new Map(),
    dedupe: new Map(),
    observationAdmission: { total: 0, perConsumer: new Map(), waiting: [] },
    dispatcher,
    confirmations: undefined as unknown as ConfirmationStore, // set below
    executor: undefined,
    disposed: false,
    registryPolicies: [...(options?.policies ?? [])],
    auditSink,
    contextFn: options?.context,
    routeFn: options?.route,
    now,
    bumpVersion() {
      internals.version += 1;
      if (!surfaceChangedScheduled) {
        surfaceChangedScheduled = true;
        queueMicrotask(() => {
          surfaceChangedScheduled = false;
          if (internals.disposed) return;
          internals.emit({ type: "surface-changed", surfaceVersion: String(internals.version) });
        });
      }
    },
    emit(event) {
      dispatcher.emit(event);
    },
    recordAudit(event: Omit<AuditEvent, "at">) {
      safeRecord(auditSink, { at: new Date(now()).toISOString(), ...event });
    },
    host() {
      try {
        return internals.contextFn?.() ?? {};
      } catch (err) {
        internals.devWarn("[agent-surface] RegistryOptions.context() threw", err);
        return {};
      }
    },
    devWarn(...args) {
      if (environment === "development") {
        // eslint-disable-next-line no-console
        console.warn(...args);
      }
    },
    devError(...args) {
      if (environment === "development") {
        // eslint-disable-next-line no-console
        console.error(...args);
      }
    },
  };

  internals.confirmations = new ConfirmationStore({
    ttlMs: limits.confirmationTtlMs,
    maxPending: limits.maxPendingConfirmations,
    now,
    emit: (event) => internals.emit(event),
    audit: (event) => internals.recordAudit(event),
  });

  const onDuplicateInstance = options?.onDuplicateInstance ?? "reject";
  const duplicateSuffixPolicy = options?.duplicateSuffixPolicy ?? "warn";

  function deadHandle(): AgentRegistrationHandle {
    const id = nextRegistrationId(() => randomBase62(6));
    return {
      registrationId: id,
      status: "rejected",
      update() {
        internals.devWarn("[agent-surface] update() called on a rejected registration handle");
      },
      invalidate() {
        internals.devWarn("[agent-surface] invalidate() called on a rejected registration handle");
      },
      unregister() {
        /* no-op */
      },
    };
  }

  function unregisterInternal(reg: InternalRegistration): void {
    if (reg.status !== "active") return;
    reg.status = "unregistered";
    internals.registrations.delete(reg.id);
    if (internals.byKey.get(reg.key) === reg.id) internals.byKey.delete(reg.key);
    addTombstone(internals, reg);
    // Abort in-flight invocations: non-navigation ones settle
    // COMPONENT_UNMOUNTED unless the handler already settled (first settle
    // wins, D16); navigation ones only lose their signal and settle on
    // handler settlement (D23).
    for (const entry of [...reg.inFlight]) {
      entry.onUnregister();
    }
    internals.bumpVersion();
    internals.emit({
      type: "component-unregistered",
      registrationId: reg.id,
      componentType: reg.type,
      instanceId: reg.instanceId,
    });
    internals.recordAudit({
      type: "unregistration",
      registrationId: reg.id,
      capabilityId: undefined,
    });
  }

  function checkSuffixCollisions(def: AgentComponentDefinition): void {
    if (duplicateSuffixPolicy === "off") return;
    const paths = internals.executor?.paths;
    if (!paths || paths.length === 0) return;
    const names = [
      ...Object.keys(def.observations ?? {}),
      ...Object.keys(def.actions ?? {}),
    ];
    for (const name of names) {
      const candidatePath = `${def.type}.${name}`;
      if (paths.includes(candidatePath)) {
        const viewCapabilityId = formatViewCapabilityId(def.type, name);
        const domainProcedureId = `domain:${candidatePath}`;
        if (duplicateSuffixPolicy === "error") {
          throw new AgentSurfaceDefinitionError(
            "PLANE_VIOLATION",
            `view capability "${viewCapabilityId}" collides with domain procedure "${domainProcedureId}" — reference the procedure instead of redefining it (docs/05)`,
          );
        }
        internals.devWarn(
          `[agent-surface] suspicious suffix collision: "${viewCapabilityId}" vs "${domainProcedureId}"`,
        );
        internals.emit({ type: "collision-suspected", viewCapabilityId, domainProcedureId });
        internals.recordAudit({
          type: "collision-suspected",
          capabilityId: viewCapabilityId,
        });
      }
    }
  }

  const registry: AgentSurfaceRegistry = {
    surfaceId: internals.surfaceId,

    register(definition: AgentComponentDefinition): AgentRegistrationHandle {
      if (internals.disposed) throw new Error("register() called on a disposed registry");

      // Structural defects throw in EVERY environment (docs/03 §registry, D4).
      validateComponentDefinition(definition, limits, {
        hasProcedureExecutor: internals.executor !== undefined,
      });
      checkSuffixCollisions(definition);

      const instanceId = definition.instanceId ?? "default";

      // Runtime conditions produce dead handles, never throws (D4).
      if (options?.onRegister) {
        let verdict: "accept" | "reject" = "accept";
        try {
          verdict = options.onRegister({
            definition,
            ...(environment === "development" ? { stack: new Error().stack } : {}),
          });
        } catch (err) {
          internals.devError("[agent-surface] onRegister guard threw; rejecting", err);
          verdict = "reject";
        }
        if (verdict === "reject") {
          internals.emit({
            type: "component-rejected",
            componentType: definition.type,
            instanceId,
            reason: "guard",
          });
          internals.recordAudit({ type: "registration-rejected" });
          internals.devError(
            `[agent-surface] registration of "${definition.type}" (${instanceId}) rejected by guard`,
          );
          return deadHandle();
        }
      }

      const key = componentKey(definition.type, instanceId);
      const existingId = internals.byKey.get(key);
      if (existingId !== undefined) {
        if (onDuplicateInstance === "reject") {
          internals.emit({
            type: "component-rejected",
            componentType: definition.type,
            instanceId,
            reason: "duplicate",
          });
          internals.recordAudit({ type: "registration-rejected" });
          internals.devError(
            `[agent-surface] duplicate registration of "${definition.type}" (${instanceId}); first-wins (onDuplicateInstance: "reject")`,
          );
          return deadHandle();
        }
        const existing = internals.registrations.get(existingId);
        if (existing) unregisterInternal(existing);
      }

      const reg = normalizeRegistration(definition, nextRegistrationId(() => randomBase62(6)));
      internals.registrations.set(reg.id, reg);
      internals.byKey.set(reg.key, reg.id);
      internals.bumpVersion();
      internals.emit({
        type: "component-registered",
        registrationId: reg.id,
        componentType: reg.type,
        instanceId: reg.instanceId,
      });
      internals.recordAudit({ type: "registration", registrationId: reg.id });

      return {
        get registrationId() {
          return reg.id;
        },
        get status() {
          return reg.status === "active" ? ("active" as const) : ("unregistered" as const);
        },
        update(patch) {
          if (reg.status !== "active") {
            internals.devWarn(
              `[agent-surface] update() called after unregistration of "${reg.type}"`,
            );
            return;
          }
          let changed = false;
          if (patch.enabled !== undefined && patch.enabled !== reg.enabled) {
            reg.enabled = patch.enabled;
            changed = true;
          }
          if (patch.availability) {
            for (const [name, value] of Object.entries(patch.availability)) {
              const prev = reg.availabilityOverrides.get(name);
              if (!prev || prev.available !== value.available || prev.reason !== value.reason) {
                reg.availabilityOverrides.set(name, {
                  available: value.available,
                  ...(value.reason !== undefined ? { reason: value.reason } : {}),
                });
                changed = true;
                const capabilityId =
                  reg.observations.get(name)?.capabilityId ??
                  reg.actions.get(name)?.capabilityId ??
                  reg.procedures.find((p) => p.path === name)?.capabilityId ??
                  name;
                internals.emit({
                  type: "availability-changed",
                  registrationId: reg.id,
                  capabilityId,
                  available: value.available,
                });
              }
            }
          }
          if (changed) internals.bumpVersion();
        },
        invalidate() {
          if (reg.status !== "active") return;
          internals.bumpVersion();
        },
        unregister() {
          unregisterInternal(reg);
        },
      };
    },

    snapshot(context?: SnapshotContext): AgentSurfaceSnapshot {
      if (internals.disposed) throw new Error("snapshot() called on a disposed registry");
      return createSnapshot(internals, context);
    },

    invoke(request, invokeOptions) {
      return performInvoke(internals, request, invokeOptions);
    },

    subscribe(listener) {
      return dispatcher.subscribe(listener);
    },

    confirmations: internals.confirmations.controller(),

    setProcedureExecutor(executor) {
      internals.executor = executor;
    },

    getVersion() {
      return String(internals.version);
    },

    dispose() {
      if (internals.disposed) return;
      for (const reg of [...internals.registrations.values()]) {
        for (const entry of [...reg.inFlight]) {
          entry.onDispose();
        }
        reg.status = "unregistered";
      }
      drainObservationQueues(internals);
      internals.registrations.clear();
      internals.byKey.clear();
      internals.confirmations.disposeAll();
      internals.disposed = true;
      dispatcher.clear();
    },
  };

  // Internal seam (DEV_WARN): adapters in this package report dev-mode repairs
  // through the registry's own environment gate rather than a second one.
  Object.defineProperty(registry, DEV_WARN, {
    value: (...args: unknown[]) => internals.devWarn(...args),
    enumerable: false,
  });

  return registry;
}

function combineSinks(...sinks: AuditSink[]): AuditSink {
  return {
    record(event) {
      for (const sink of sinks) safeRecord(sink, event);
    },
  };
}
