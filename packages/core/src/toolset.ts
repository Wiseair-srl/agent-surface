import type { AgentConsumer, JsonSchema, JsonValue, Unsubscribe } from "./types.js";
import type { AgentSurfaceRegistry } from "./registry.js";
import type { AgentInvocationResult } from "./invocation-types.js";
import type {
  AgentActionDescriptor,
  AgentObservationDescriptor,
  AgentProcedureDescriptor,
  AgentSurfaceSnapshot,
} from "./snapshot.js";
import { assignWireNames, type WireNameEntry } from "./ids.js";
import { stableDescriptionOf } from "./snapshot.js";
import { randomBase62 } from "./utils.js";

export interface AgentToolsetOptions {
  consumer: AgentConsumer;
  /**
   * "direct": one tool per capability — provider-native input typing, catalog
   * size linear in the surface. "meta": three fixed tools with lazy discovery —
   * constant tool-block size, one extra round trip before the first act.
   * Default "direct"; see the selection guide in docs/09 §choosing-a-mode.
   */
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
  /**
   * D28 compatibility flag. `true` (default through 0.4; flips in 0.5) composes
   * availability and the contextual note into `description`, as 0.1 did.
   * `false` keeps `description` free of live state, so the provider tool block
   * is byte-stable across steps and prompt-prefix caching survives; the host
   * renders `AgentTool.state` outside the tool definitions (docs/09
   * §rendering-capability-state). `state` is populated either way.
   */
  descriptionIncludesState?: boolean;
}

export interface AgentTool {
  /** Wire-safe name (docs/09 §wire-names), ≤ 64 chars, unique in this catalog. */
  name: string;
  /**
   * Plane + effect + confirmation prefix, then the authored description.
   * With `descriptionIncludesState: false` this contains NO live state — it is
   * safe in a provider tool block with prompt-prefix caching across steps.
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
    /** Live text contributed by a contextual binding's `describe()`. */
    note?: string;
  };
  execute(input: JsonValue, call: { toolCallId?: string }): Promise<AgentInvocationResult>;
}

export interface AgentToolset {
  tools(): AgentTool[]; // recomputed per surface version
  /**
   * wireName → canonical capability id, for the catalog `tools()` last built.
   * Authoritative: shortened names are not decodable by string surgery, so a
   * host MUST consult this rather than reversing names itself (D30). Empty in
   * "meta" mode, whose three tool names are not capability ids.
   */
  wireNameMap(): ReadonlyMap<string, string>;
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

/**
 * Stable properties of the capability — plane, effect, confirmation. Never
 * availability: that is a property of the moment, and folding it in here is
 * what made the tool block churn between steps (D28).
 */
function describePrefix(
  plane: "view" | "domain",
  effect: string,
  confirmation: "never" | "optional" | "required",
): string {
  const parts = [plane, effect];
  if (confirmation === "required") parts.push("requires confirmation");
  return `[${parts.join(" · ")}]`;
}

/** Pre-D28 composition, byte-identical to 0.1, kept behind the compat flag. */
function legacyDescription(
  prefix: string,
  description: string,
  state: AgentTool["state"],
): string {
  const unavailable = state.available
    ? ""
    : ` [currently unavailable${state.unavailableReason ? `: ${state.unavailableReason}` : ""}]`;
  const note = state.note ? ` ${state.note}` : "";
  return `${prefix}${unavailable} ${description}${note}`;
}

function availabilityState(descriptor: {
  available: boolean;
  unavailableReason?: string;
  contextualNote?: string;
}): AgentTool["state"] {
  return {
    available: descriptor.available,
    ...(descriptor.unavailableReason !== undefined
      ? { unavailableReason: descriptor.unavailableReason }
      : {}),
    ...(descriptor.contextualNote !== undefined ? { note: descriptor.contextualNote } : {}),
  };
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
  const descriptionIncludesState = options.descriptionIncludesState ?? true;
  const listeners = new Set<(tools: AgentTool[]) => void>();
  const pendingWaits = new Set<AbortController>();
  let disposed = false;
  let cachedVersion: string | undefined;
  let cachedTools: AgentTool[] | undefined;
  let cachedWireNames: ReadonlyMap<string, string> = new Map();
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

  function buildDirectTools(): { tools: AgentTool[]; wireNames: ReadonlyMap<string, string> } {
    const snapshot = registry.snapshot({
      consumer: options.consumer,
      ...(options.scope ? { scope: options.scope } : {}),
      includeUnavailable: true,
    });

    interface PendingTool {
      wire: WireNameEntry;
      entry: CatalogEntry;
      prefix: string;
      description: string;
      inputSchema: JsonSchema;
      state: AgentTool["state"];
    }
    const pending: PendingTool[] = [];

    const push = (
      capabilityId: string,
      kind: CatalogEntry["kind"],
      registrationId: string,
      instanceId: string | undefined,
      prefix: string,
      description: string,
      inputSchema: JsonSchema,
      state: AgentTool["state"],
      nameSuffix?: string,
    ): void => {
      const suffix = nameSuffix ?? instanceId;
      pending.push({
        // Providers require unique tool names: multi-instance capabilities
        // are disambiguated with an `_at_<instance>` suffix (docs/09).
        wire: { id: capabilityId, ...(suffix !== undefined ? { instanceId: suffix } : {}) },
        entry: {
          capabilityId,
          registrationId,
          ...(instanceId !== undefined ? { instanceId } : {}),
          surfaceVersion: snapshot.surfaceVersion,
          kind,
        },
        prefix,
        description,
        inputSchema,
        state,
      });
    };

    // One pre-pass instead of a filter() per component: at 300 mounted
    // components the quadratic version cost ~90k comparisons per projection.
    const typeCounts = new Map<string, number>();
    for (const component of snapshot.components) {
      typeCounts.set(component.type, (typeCounts.get(component.type) ?? 0) + 1);
    }

    for (const component of snapshot.components) {
      const multiInstance = (typeCounts.get(component.type) ?? 0) > 1;
      const instanceId = multiInstance ? component.instanceId : undefined;
      for (const obs of component.observations) {
        push(
          obs.capabilityId,
          "observation",
          component.registrationId,
          instanceId,
          describePrefix("view", "read", "never"),
          obs.description,
          EMPTY_INPUT_SCHEMA,
          availabilityState(obs),
        );
      }
      for (const act of component.actions) {
        push(
          act.capabilityId,
          "action",
          component.registrationId,
          instanceId,
          describePrefix("view", act.effect, act.confirmation),
          act.description,
          act.inputSchema,
          availabilityState(act),
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
        describePrefix("domain", proc.effect, proc.confirmation),
        // The stable half only: a contextual note travels in `state.note`.
        stableDescriptionOf(proc),
        proc.inputSchema,
        availabilityState(proc),
        needsSuffix
          ? (proc.context?.instanceId ?? proc.registrationId.replace(/[^A-Za-z0-9_-]/g, ""))
          : undefined,
      );
    }

    // Uniqueness is a catalog property, not a per-name one (AS-WIRE-006).
    const assignment = assignWireNames(pending.map((p) => p.wire));
    const tools = pending.map((p, i) => ({
      name: assignment.names[i]!,
      description: descriptionIncludesState
        ? legacyDescription(p.prefix, p.description, p.state)
        : `${p.prefix} ${p.description}`,
      inputSchema: p.inputSchema,
      state: p.state,
      execute: (input: JsonValue, call: { toolCallId?: string }) =>
        invokeThroughSurface(p.entry, input, call.toolCallId),
    }));
    return { tools, wireNames: assignment.byName };
  }

  function buildMetaTools(): AgentTool[] {
    const snapshotFor = (): AgentSurfaceSnapshot =>
      registry.snapshot({
        consumer: options.consumer,
        ...(options.scope ? { scope: options.scope } : {}),
      });
    // The three verbs are always callable; per-capability availability lives in
    // the `surface_discover` payload, where the model actually reads it.
    const verbs: Array<Omit<AgentTool, "state">> = [
      {
        name: "surface_discover",
        description:
          "[meta] Discover the current agent surface: components, capabilities, procedures, availability, schemas.",
        inputSchema: {
          type: "object",
          properties: {
            scope: {
              type: "array",
              items: { type: "string" },
              // No enum: valid tokens are live component types, and inlining
              // them would make this tool block churn on every mount —
              // the churn AS-META-005 and D28 exist to prevent.
              description:
                'Component-type prefixes to narrow the result, e.g. ["devices.table"], taken from `components[].type` of an earlier call — omit on the first. Narrows only: prefixes outside this host\'s configured scope match nothing and come back in `scopeRejected`.',
            },
          },
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
          // The refusal is marked for the same reason budget truncation is —
          // an unexplained blank payload reads as "the surface is empty", which
          // is the one conclusion the model must not draw here (AS-META-006).
          const projected: AgentSurfaceSnapshot = {
            ...snapshot,
            // A disjoint request is snapshotted unscoped, so any `truncated`
            // count belongs to a surface this payload does not contain. Keeping
            // it would claim a budget dropped what scope did.
            ...(effective.empty
              ? { components: [], procedures: [], truncated: undefined }
              : {}),
            ...(effective.rejected.length > 0
              ? { scopeRejected: { prefixes: effective.rejected } }
              : {}),
          };
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
            capabilityId: {
              type: "string",
              description:
                "Observation id, verbatim from `observations[].capabilityId` in a discover result.",
            },
            instanceId: {
              type: "string",
              description:
                "Only when several components share a type: `components[].instanceId` picks one.",
            },
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
        description:
          "[meta] Invoke an action or procedure by capabilityId. Echo the surfaceVersion you discovered so a surface that changed underneath a destructive plan is rejected rather than executed.",
        inputSchema: {
          type: "object",
          properties: {
            capabilityId: {
              type: "string",
              description:
                "Action `capabilityId` or `procedureId`, verbatim from a discover result.",
            },
            instanceId: {
              type: "string",
              description:
                "Only when several components share a type: `components[].instanceId` picks one.",
            },
            input: { description: "Arguments matching that capability's `inputSchema`." },
            invocationId: {
              type: "string",
              description:
                "Reuse a previous call's id to retry without executing twice; required when resuming after CONFIRMATION_REQUIRED.",
            },
            confirmationId: {
              type: "string",
              description:
                "The id returned with CONFIRMATION_REQUIRED, sent back after the user approves.",
            },
            surfaceVersion: {
              type: "string",
              description:
                "The `surfaceVersion` you planned against. Send it for destructive or externally-visible calls: a surface that moved underneath the plan then fails instead of executing. Omitted, the call binds to what is live now.",
            },
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
            surfaceVersion?: string;
          };
          const snapshot = snapshotFor();
          const registrationId = findRegistrationId(snapshot, req.capabilityId, req.instanceId);
          // One execution path with direct mode: same resolution, same
          // staleness binding, same wait-mode confirmation retry (D26). A
          // direct tool carries the version of the catalog it was built from;
          // the equivalent here is the version the model discovered, so it is
          // taken from the caller when supplied (AS-META-004).
          return invokeThroughSurface(
            {
              capabilityId: req.capabilityId,
              ...(registrationId !== undefined ? { registrationId } : {}),
              ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
              surfaceVersion: req.surfaceVersion ?? snapshot.surfaceVersion,
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
    return verbs.map((verb) => ({ ...verb, state: { available: true } }));
  }

  function computeTools(): AgentTool[] {
    if (mode === "meta") {
      cachedTools ??= buildMetaTools();
      return cachedTools;
    }
    const version = registry.getVersion();
    if (cachedTools && cachedVersion === version) return cachedTools;
    const built = buildDirectTools();
    cachedTools = built.tools;
    cachedWireNames = built.wireNames;
    cachedVersion = version;
    return cachedTools;
  }

  /**
   * Includes `state`: with `descriptionIncludesState: false` the definitions
   * are byte-identical across an availability flip, and a host that re-renders
   * its state block on `subscribe` would otherwise never hear about it.
   */
  function signatureOf(tools: AgentTool[]): string {
    return JSON.stringify(
      tools.map((t) => [t.name, t.description, t.inputSchema, t.state]),
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
    wireNameMap() {
      if (mode === "meta") return new Map();
      computeTools();
      return cachedWireNames;
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
 *
 * `rejected` names the requested prefixes the floor admitted nothing for, in
 * request order. It carries the whole request when the two are disjoint, and a
 * subset when only part of the request was out of bounds; both are cases where
 * the model asked for something and got silence back (AS-META-006). A prefix
 * broader than the floor is *not* rejected: it contributed the floor's own
 * narrower prefix, which is the narrowing D27 describes.
 */
function intersectScope(
  floor: string[] | undefined,
  requested: string[] | undefined,
): { scope?: string[]; empty: boolean; rejected: string[] } {
  const hasFloor = floor !== undefined && floor.length > 0;
  // `[]` is "everything" to matchesScope — treat it as "unspecified", so an
  // empty array cannot be used to widen past the floor.
  if (requested === undefined || requested.length === 0) {
    return hasFloor ? { scope: floor, empty: false, rejected: [] } : { empty: false, rejected: [] };
  }
  if (!hasFloor) return { scope: requested, empty: false, rejected: [] };
  const out = new Set<string>();
  const rejected: string[] = [];
  for (const r of requested) {
    let admitted = false;
    for (const f of floor) {
      if (r === f || r.startsWith(`${f}.`)) {
        out.add(r);
        admitted = true;
      } else if (f.startsWith(`${r}.`)) {
        out.add(f);
        admitted = true;
      }
    }
    // Deduped: a repeated prefix is one refusal, not one per occurrence.
    if (!admitted && !rejected.includes(r)) rejected.push(r);
  }
  return out.size > 0
    ? { scope: [...out], empty: false, rejected }
    : { empty: true, rejected };
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
