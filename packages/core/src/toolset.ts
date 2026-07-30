import type { AgentConsumer, JsonSchema, JsonValue, Unsubscribe } from "./types.js";
import type { AgentSurfaceRegistry } from "./registry.js";
import type { AgentInvocationResult } from "./invocation-types.js";
import type {
  AgentActionDescriptor,
  AgentObservationDescriptor,
  AgentProcedureDescriptor,
  AgentSurfaceSnapshot,
} from "./snapshot.js";
import { encodeWireNameForInstance } from "./ids.js";
import { randomBase62 } from "./utils.js";

export interface AgentToolsetOptions {
  consumer: AgentConsumer;
  /** "direct": one tool per capability. "meta": 3 generic tools. [meta: Experimental] */
  mode?: "direct" | "meta";
  /**
   * Loop topology (D26). Sets the confirmation-mode default: "embedded" →
   * "wait", "remote" → "two-phase". One of `topology` or `confirmations`
   * MUST be provided — there is no ambiguous global default.
   */
  topology?: "embedded" | "remote";
  /**
   * "wait": on CONFIRMATION_REQUIRED, await user resolution (up to TTL) and
   * auto-retry, so the model sees one tool call → one final result.
   * "two-phase": surface CONFIRMATION_REQUIRED to the model, which retries.
   * Overrides the topology default (a remote loop opting into "wait" owns
   * its transport-timeout story, docs/09 §confirmation-topology).
   */
  confirmations?: "wait" | "two-phase";
  /**
   * Component-type prefixes this consumer may discover. D27: this is a
   * **floor** — in "meta" mode a model-supplied `scope` can only narrow it
   * further, never widen it. Not an authority boundary: `invoke` does not
   * check scope in either mode (docs/09 §scope-is-discovery-only).
   */
  scope?: string[];
  /**
   * [Experimental] Snapshot truncation budget for `surface_discover`.
   * "meta" mode only — there the `truncated` marker rides in the payload the
   * model reads. In "direct" mode a budget would silently drop tools with no
   * signal to anyone, so it is rejected rather than half-honored.
   */
  budget?: { maxComponents?: number; maxBytes?: number };
}

export interface AgentTool {
  /** Wire-safe name (docs/09 §wire-names), ≤ 64 chars. */
  name: string;
  description: string; // includes [view|domain] + effect prefix
  inputSchema: JsonSchema;
  execute(input: JsonValue, call: { toolCallId?: string }): Promise<AgentInvocationResult>;
}

export interface AgentToolset {
  tools(): AgentTool[]; // recomputed per surface version
  /** Fires when tools() would return a different catalog. */
  subscribe(listener: (tools: AgentTool[]) => void): Unsubscribe;
  dispose(): void;
}

interface CatalogEntry {
  capabilityId: string;
  /**
   * Omitted when the target is not uniquely resolvable from the snapshot, so
   * the registry's own resolver decides (AMBIGUOUS_INSTANCE / not-found /
   * unmounted). Never send a placeholder: an empty string reads as "this exact
   * registration", which resolves to STALE_CAPABILITY and sends the agent into
   * a refresh loop against an unchanged surface (AS-ADAPTER-003).
   */
  registrationId?: string;
  instanceId?: string;
  surfaceVersion: string;
  kind: "observation" | "action" | "procedure";
}

const EMPTY_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function describePrefix(
  plane: "view" | "domain",
  effect: string,
  confirmation: "never" | "optional" | "required",
  available: boolean,
  unavailableReason: string | undefined,
): string {
  const parts = [plane, effect];
  if (confirmation === "required") parts.push("requires confirmation");
  let prefix = `[${parts.join(" · ")}]`;
  if (!available) {
    prefix += ` [currently unavailable${unavailableReason ? `: ${unavailableReason}` : ""}]`;
  }
  return prefix;
}

export function createAgentToolset(
  registry: AgentSurfaceRegistry,
  options: AgentToolsetOptions,
): AgentToolset {
  const mode = options.mode ?? "direct";
  if (options.confirmations === undefined && options.topology === undefined) {
    // D26: no ambiguous global default — programmer misuse, every environment.
    throw new Error(
      "createAgentToolset: declare a topology ('embedded' | 'remote') or an explicit confirmations mode ('wait' | 'two-phase'). Embedded loops default to 'wait', remote loops to 'two-phase' (docs/09 §confirmation-topology).",
    );
  }
  if (options.budget !== undefined && mode !== "meta") {
    // No silent no-op: in direct mode a budget would drop tools from the
    // catalog with no `truncated` marker anywhere the host or model can see.
    throw new Error(
      "createAgentToolset: `budget` applies to mode 'meta' only — in 'direct' mode it would silently drop tools. Pass a `scope` to bound a direct catalog instead (docs/09 §meta-tools-mode).",
    );
  }
  const confirmationsMode =
    options.confirmations ?? (options.topology === "remote" ? "two-phase" : "wait");
  const listeners = new Set<(tools: AgentTool[]) => void>();
  const pendingWaits = new Set<AbortController>();
  let disposed = false;
  let cachedVersion: string | undefined;
  let cachedTools: AgentTool[] | undefined;
  let cachedSignature: string | undefined;

  /** Wait for a confirmation, abortable by dispose (AS-TOPO-003, D26).
   * The disposed guard covers the window where dispose lands between the
   * CONFIRMATION_REQUIRED result and this wait's registration. */
  async function waitForConfirmation(confirmationId: string): Promise<void> {
    if (disposed) return;
    const controller = new AbortController();
    pendingWaits.add(controller);
    try {
      await registry.confirmations.waitFor(confirmationId, { signal: controller.signal });
    } finally {
      pendingWaits.delete(controller);
    }
  }

  async function invokeThroughSurface(
    entry: CatalogEntry,
    input: JsonValue | undefined,
    toolCallId: string | undefined,
    overrides?: { invocationId?: string; confirmationId?: string },
  ): Promise<AgentInvocationResult> {
    const invocationId = overrides?.invocationId ?? toolCallId ?? `inv_${randomBase62(12)}`;
    const base = {
      invocationId,
      capabilityId: entry.capabilityId,
      ...(entry.instanceId !== undefined ? { instanceId: entry.instanceId } : {}),
      ...(entry.registrationId !== undefined ? { registrationId: entry.registrationId } : {}),
      surfaceVersion: entry.surfaceVersion,
      ...(input !== undefined ? { input } : {}),
      ...(overrides?.confirmationId !== undefined
        ? { confirmationId: overrides.confirmationId }
        : {}),
    };
    let result = await registry.invoke(base, { consumer: options.consumer });
    if (
      confirmationsMode === "wait" &&
      result.status === "error" &&
      result.error.code === "CONFIRMATION_REQUIRED"
    ) {
      const confirmationId = result.error.details?.confirmationId;
      if (typeof confirmationId === "string") {
        await waitForConfirmation(confirmationId);
        // Deterministic shutdown: a dispose mid-wait returns the pending
        // CONFIRMATION_REQUIRED result as-is (D26).
        if (disposed) return result;
        // Retry reuses the SAME invocationId + confirmationId (docs/03 D14):
        // CONFIRMATION_REQUIRED was not cached as terminal, so this executes.
        result = await registry.invoke(
          { ...base, confirmationId },
          { consumer: options.consumer },
        );
      }
    }
    return result;
  }

  function buildDirectTools(): AgentTool[] {
    const snapshot = registry.snapshot({
      consumer: options.consumer,
      ...(options.scope ? { scope: options.scope } : {}),
      includeUnavailable: true,
    });
    const tools: AgentTool[] = [];

    const push = (
      capabilityId: string,
      kind: CatalogEntry["kind"],
      registrationId: string,
      instanceId: string | undefined,
      description: string,
      inputSchema: JsonSchema,
      nameSuffix?: string,
    ): void => {
      const entry: CatalogEntry = {
        capabilityId,
        registrationId,
        ...(instanceId !== undefined ? { instanceId } : {}),
        surfaceVersion: snapshot.surfaceVersion,
        kind,
      };
      tools.push({
        // Providers require unique tool names: multi-instance capabilities
        // are disambiguated with an `_at_<instance>` suffix (docs/09).
        name: encodeWireNameForInstance(capabilityId, nameSuffix ?? instanceId),
        description,
        inputSchema,
        execute: (input, call) => invokeThroughSurface(entry, input, call.toolCallId),
      });
    };

    for (const component of snapshot.components) {
      const multiInstance =
        snapshot.components.filter((c) => c.type === component.type).length > 1;
      const instanceId = multiInstance ? component.instanceId : undefined;
      for (const obs of component.observations) {
        push(
          obs.capabilityId,
          "observation",
          component.registrationId,
          instanceId,
          `${describePrefix("view", "read", "never", obs.available, obs.unavailableReason)} ${obs.description}`,
          EMPTY_INPUT_SCHEMA,
        );
      }
      for (const act of component.actions) {
        push(
          act.capabilityId,
          "action",
          component.registrationId,
          instanceId,
          `${describePrefix("view", act.effect, act.confirmation, act.available, act.unavailableReason)} ${act.description}`,
          act.inputSchema,
        );
      }
    }
    const procedureCounts = new Map<string, number>();
    for (const proc of snapshot.procedures) {
      procedureCounts.set(proc.procedureId, (procedureCounts.get(proc.procedureId) ?? 0) + 1);
    }
    for (const proc of snapshot.procedures) {
      const needsSuffix = (procedureCounts.get(proc.procedureId) ?? 0) > 1;
      push(
        proc.procedureId,
        "procedure",
        proc.registrationId,
        undefined,
        `${describePrefix("domain", proc.effect, proc.confirmation, proc.available, proc.unavailableReason)} ${proc.description}`,
        proc.inputSchema,
        needsSuffix
          ? (proc.context?.instanceId ?? proc.registrationId.replace(/[^A-Za-z0-9_-]/g, ""))
          : undefined,
      );
    }
    return tools;
  }

  function buildMetaTools(): AgentTool[] {
    const snapshotFor = (): AgentSurfaceSnapshot =>
      registry.snapshot({
        consumer: options.consumer,
        ...(options.scope ? { scope: options.scope } : {}),
      });
    return [
      {
        name: "surface_discover",
        description:
          "[meta] Discover the current agent surface: components, capabilities, procedures, availability, schemas.",
        inputSchema: {
          type: "object",
          properties: { scope: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
        async execute(input) {
          const requested = (input as { scope?: string[] } | undefined)?.scope;
          // D27: the configured scope is a floor; a model-supplied scope narrows.
          const effective = intersectScope(options.scope, requested);
          const snapshot = registry.snapshot({
            consumer: options.consumer,
            ...(effective.scope ? { scope: effective.scope } : {}),
            ...(options.budget ? { budget: options.budget } : {}),
          });
          // Disjoint request: honored as "nothing", never widened to the floor.
          const projected: AgentSurfaceSnapshot = effective.empty
            ? { ...snapshot, components: [], procedures: [] }
            : snapshot;
          return {
            status: "ok",
            invocationId: `inv_${randomBase62(12)}`,
            capabilityId: "meta:surface.discover",
            output: JSON.parse(JSON.stringify(projected)) as JsonValue,
            surfaceVersion: snapshot.surfaceVersion,
          };
        },
      },
      {
        name: "surface_read",
        description: "[meta] Invoke an observation by capabilityId and return its output.",
        inputSchema: {
          type: "object",
          properties: {
            capabilityId: { type: "string" },
            instanceId: { type: "string" },
          },
          required: ["capabilityId"],
          additionalProperties: false,
        },
        async execute(input, call) {
          const req = input as { capabilityId: string; instanceId?: string };
          const snapshot = snapshotFor();
          const registrationId = findRegistrationId(snapshot, req.capabilityId, req.instanceId);
          return invokeThroughSurface(
            {
              capabilityId: req.capabilityId,
              // Unresolved → let the registry answer (AS-ADAPTER-003).
              ...(registrationId !== undefined ? { registrationId } : {}),
              ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
              surfaceVersion: snapshot.surfaceVersion,
              kind: "observation",
            },
            undefined,
            call.toolCallId,
          );
        },
      },
      {
        name: "surface_act",
        description: "[meta] Invoke an action or procedure by capabilityId.",
        inputSchema: {
          type: "object",
          properties: {
            capabilityId: { type: "string" },
            instanceId: { type: "string" },
            input: {},
            invocationId: { type: "string" },
            confirmationId: { type: "string" },
          },
          required: ["capabilityId"],
          additionalProperties: false,
        },
        async execute(input, call) {
          const req = input as {
            capabilityId: string;
            instanceId?: string;
            input?: JsonValue;
            invocationId?: string;
            confirmationId?: string;
          };
          const snapshot = snapshotFor();
          const registrationId = findRegistrationId(snapshot, req.capabilityId, req.instanceId);
          // One execution path with direct mode: same resolution, same
          // staleness binding, same wait-mode confirmation retry (D26).
          return invokeThroughSurface(
            {
              capabilityId: req.capabilityId,
              ...(registrationId !== undefined ? { registrationId } : {}),
              ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
              surfaceVersion: snapshot.surfaceVersion,
              kind: "action",
            },
            req.input,
            call.toolCallId,
            {
              ...(req.invocationId !== undefined ? { invocationId: req.invocationId } : {}),
              ...(req.confirmationId !== undefined ? { confirmationId: req.confirmationId } : {}),
            },
          );
        },
      },
    ];
  }

  function computeTools(): AgentTool[] {
    if (mode === "meta") {
      cachedTools ??= buildMetaTools();
      return cachedTools;
    }
    const version = registry.getVersion();
    if (cachedTools && cachedVersion === version) return cachedTools;
    cachedTools = buildDirectTools();
    cachedVersion = version;
    return cachedTools;
  }

  function signatureOf(tools: AgentTool[]): string {
    return JSON.stringify(
      tools.map((t) => [t.name, t.description, t.inputSchema]),
    );
  }

  const unsubscribe = registry.subscribe((event) => {
    if (disposed || event.type !== "surface-changed") return;
    cachedVersion = undefined;
    // Meta mode: the three-tool catalog is constant by construction, so
    // tools() can never differ and listeners are never called. Agents notice
    // surface changes by re-running surface_discover and comparing
    // surfaceVersion (docs/09 §meta-tools-mode).
    if (mode === "meta") return;
    const tools = computeTools();
    const signature = signatureOf(tools);
    if (signature === cachedSignature) return;
    cachedSignature = signature;
    for (const listener of [...listeners]) {
      try {
        listener(tools);
      } catch {
        /* listener isolation */
      }
    }
  });

  return {
    tools() {
      const tools = computeTools();
      cachedSignature ??= signatureOf(tools);
      return tools;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      listeners.clear();
      // Settle in-flight wait-mode waits deterministically (D26).
      for (const controller of [...pendingWaits]) controller.abort();
      pendingWaits.clear();
    },
  };
}

/**
 * D27 — the adapter-configured scope is a floor, not a default. A model-supplied
 * scope may narrow it (`["devices"]` → `["devices.table"]`), never widen it
 * (`[]` or `["admin"]` cannot reach past the floor). Prefix lists intersect
 * pairwise: the more specific prefix wins when one extends the other, and a
 * pair that shares no prefix contributes nothing. An empty result means the
 * request was entirely outside the floor — reported as an empty surface rather
 * than silently falling back to the floor itself.
 */
function intersectScope(
  floor: string[] | undefined,
  requested: string[] | undefined,
): { scope?: string[]; empty: boolean } {
  const hasFloor = floor !== undefined && floor.length > 0;
  // `[]` is "everything" to matchesScope — treat it as "unspecified", so an
  // empty array cannot be used to widen past the floor.
  if (requested === undefined || requested.length === 0) {
    return hasFloor ? { scope: floor, empty: false } : { empty: false };
  }
  if (!hasFloor) return { scope: requested, empty: false };
  const out = new Set<string>();
  for (const f of floor) {
    for (const r of requested) {
      if (r === f || r.startsWith(`${f}.`)) out.add(r);
      else if (f.startsWith(`${r}.`)) out.add(f);
    }
  }
  return out.size > 0 ? { scope: [...out], empty: false } : { empty: true };
}

function findRegistrationId(
  snapshot: AgentSurfaceSnapshot,
  capabilityId: string,
  instanceId: string | undefined,
): string | undefined {
  const matches: string[] = [];
  for (const component of snapshot.components) {
    if (instanceId !== undefined && component.instanceId !== instanceId) continue;
    const all: Array<AgentObservationDescriptor | AgentActionDescriptor> = [
      ...component.observations,
      ...component.actions,
    ];
    if (all.some((c) => c.capabilityId === capabilityId)) matches.push(component.registrationId);
  }
  for (const proc of snapshot.procedures as AgentProcedureDescriptor[]) {
    if (proc.procedureId === capabilityId) matches.push(proc.registrationId);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
