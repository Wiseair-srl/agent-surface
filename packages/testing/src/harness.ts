import {
  createAgentSurfaceRegistry,
  memoryAuditSink,
  type AgentConsumer,
  type AgentInvocationResult,
  type AgentSurfaceEvent,
  type AgentSurfaceRegistry,
  type AgentSurfaceSnapshot,
  type AuditEvent,
  type CapabilityAuthority,
  type JsonValue,
  type PendingConfirmation,
  type SnapshotContext,
} from "@agent-surface/core";

export interface TestSurfaceOptions {
  registry?: AgentSurfaceRegistry; // default: fresh registry, environment "test"
  authority?: CapabilityAuthority; // required when registry is omitted
  consumer?: AgentConsumer; // default {id:"test", kind:"test"}
  host?: Record<string, unknown>; // overrides RegistryOptions.context()
}

export interface TestSurface {
  registry: AgentSurfaceRegistry;
  snapshot(ctx?: Partial<SnapshotContext>): AgentSurfaceSnapshot;

  /** Invoke with test conveniences: auto invocationId, auto registrationId
      resolution from the latest snapshot, typed input. */
  invoke(
    capabilityId: string,
    input?: JsonValue,
    opts?: {
      instanceId?: string;
      registrationId?: string; // pass a captured one to simulate staleness
      surfaceVersion?: string;
      confirmationId?: string;
      consumer?: AgentConsumer;
    },
  ): Promise<AgentInvocationResult>;

  /** Sugar: invoke an observation and return its parsed output (throws on error). */
  observe<T = JsonValue>(capabilityId: string, opts?: { instanceId?: string }): Promise<T>;

  /** Capture current resolution tokens for later stale-invocation tests. */
  captureRef(
    capabilityId: string,
    instanceId?: string,
  ): { registrationId: string; surfaceVersion: string };

  /** Swap host context mid-test (auth changes): as({user: admin}). */
  as(host: Record<string, unknown>): void;

  confirmations: {
    pending(): PendingConfirmation[];
    approve(confirmationId?: string): void; // default: the only pending one
    deny(confirmationId?: string, reason?: string): void;
    expire(confirmationId?: string): void; // force-expires that record
  };

  /** All registry events recorded since creation, in order. */
  events(): AgentSurfaceEvent[];
  auditLog(): AuditEvent[];

  dispose(): void;
}

export function createTestSurface(options?: TestSurfaceOptions): TestSurface {
  const hostRef: { current: Record<string, unknown> } = { current: options?.host ?? {} };
  const consumer: AgentConsumer = options?.consumer ?? { id: "test", kind: "test" };
  const auditSink = memoryAuditSink({ capacity: 5000 });
  const ownsRegistry = options?.registry === undefined;

  const registry =
    options?.registry ??
    createAgentSurfaceRegistry({
      environment: "test",
      ...(options?.authority ? { authority: options.authority } : {}),
      context: () => hostRef.current,
      audit: auditSink,
    });

  const events: AgentSurfaceEvent[] = [];
  const unsubscribe = registry.subscribe((event) => {
    events.push(event);
  });

  function resolveRegistrationId(
    capabilityId: string,
    instanceId: string | undefined,
  ): string | undefined {
    const snapshot = registry.snapshot({ consumer });
    const matches: string[] = [];
    for (const component of snapshot.components) {
      if (instanceId !== undefined && component.instanceId !== instanceId) continue;
      const caps = [...component.observations, ...component.actions];
      if (caps.some((c) => c.capabilityId === capabilityId)) {
        matches.push(component.registrationId);
      }
    }
    for (const proc of snapshot.procedures) {
      if (proc.procedureId === capabilityId) matches.push(proc.registrationId);
    }
    // Auto-attach only when unambiguous; otherwise let the registry produce
    // AMBIGUOUS_INSTANCE / CAPABILITY_NOT_FOUND / COMPONENT_UNMOUNTED.
    return matches.length === 1 ? matches[0] : undefined;
  }

  function pickPending(confirmationId: string | undefined): string {
    if (confirmationId !== undefined) return confirmationId;
    const pending = registry.confirmations.pending();
    if (pending.length === 1) return pending[0]!.confirmationId;
    throw new Error(
      pending.length === 0
        ? "no pending confirmation to resolve"
        : "multiple pending confirmations — pass an explicit confirmationId",
    );
  }

  const surface: TestSurface = {
    registry,

    snapshot(ctx) {
      return registry.snapshot({ consumer, ...ctx });
    },

    invoke(capabilityId, input, opts) {
      const registrationId =
        opts?.registrationId !== undefined
          ? opts.registrationId
          : resolveRegistrationId(capabilityId, opts?.instanceId);
      return registry.invoke(
        {
          capabilityId,
          ...(input !== undefined ? { input } : {}),
          ...(opts?.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
          ...(registrationId !== undefined ? { registrationId } : {}),
          ...(opts?.surfaceVersion !== undefined ? { surfaceVersion: opts.surfaceVersion } : {}),
          ...(opts?.confirmationId !== undefined ? { confirmationId: opts.confirmationId } : {}),
        },
        { consumer: opts?.consumer ?? consumer },
      );
    },

    async observe<T = JsonValue>(capabilityId: string, opts?: { instanceId?: string }): Promise<T> {
      const versionBefore = registry.getVersion();
      const result = await surface.invoke(capabilityId, undefined, opts);
      if (result.status === "error") {
        throw new Error(
          `observe(${capabilityId}) failed: ${result.error.code} — ${result.error.message}`,
        );
      }
      const versionAfter = registry.getVersion();
      if (versionAfter !== versionBefore) {
        throw new Error(
          `observe(${capabilityId}) mutated the surface (version ${versionBefore} → ${versionAfter}); observations MUST be side-effect free (docs/01)`,
        );
      }
      return result.output as T;
    },

    captureRef(capabilityId, instanceId) {
      const registrationId = resolveRegistrationId(capabilityId, instanceId);
      if (registrationId === undefined) {
        throw new Error(`captureRef: no unique live registration exposes ${capabilityId}`);
      }
      return { registrationId, surfaceVersion: registry.getVersion() };
    },

    as(host) {
      if (!ownsRegistry) {
        throw new Error(
          "as() requires a harness-created registry — pass `host` through your own RegistryOptions.context instead",
        );
      }
      hostRef.current = host;
    },

    confirmations: {
      pending() {
        return registry.confirmations.pending();
      },
      approve(confirmationId) {
        registry.confirmations.resolve(pickPending(confirmationId), { approved: true });
      },
      deny(confirmationId, reason) {
        registry.confirmations.resolve(pickPending(confirmationId), {
          approved: false,
          ...(reason !== undefined ? { reason } : {}),
        });
      },
      expire(confirmationId) {
        registry.confirmations.forceExpire(pickPending(confirmationId));
      },
    },

    events() {
      return [...events];
    },

    auditLog() {
      return auditSink.events();
    },

    dispose() {
      unsubscribe();
      if (ownsRegistry) registry.dispose();
    },
  };

  return surface;
}
