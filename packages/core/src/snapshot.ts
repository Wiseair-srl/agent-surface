import type {
  AgentConsumer,
  AgentProcedureEffect,
  AgentRouteInfo,
  JsonSchema,
  JsonValue,
} from "./types.js";
import type { RegistryInternals, InternalRegistration, ConfirmationLevel } from "./internal.js";
import {
  buildPolicyContext,
  computeAvailability,
  policiesFor,
} from "./internal.js";
import { evaluateDiscovery } from "./policy.js";
import { byteLength, deepFreeze } from "./utils.js";

export interface SnapshotContext {
  consumer?: AgentConsumer; // default: {"id":"anonymous","kind":"embedded"}
  /** Component-type prefixes to include, e.g. ["devices"]. Default: all. */
  scope?: string[];
  /** Include visible-disabled capabilities. Default true. */
  includeUnavailable?: boolean;
  /** [Experimental] Truncation budget. */
  budget?: { maxComponents?: number; maxBytes?: number };
}

export interface AgentSurfaceSnapshot {
  surfaceId: string;
  surfaceVersion: string;
  capturedAt: string; // ISO-8601
  route?: AgentRouteInfo;
  components: AgentComponentDescriptor[];
  /** Domain references, top-level (planes are not nested into each other). */
  procedures: AgentProcedureDescriptor[];
  /** [Experimental] Present iff a budget truncated the snapshot. */
  truncated?: { droppedComponents: number };
  /**
   * [Experimental] Present iff a configured scope floor refused part of a
   * requested scope (D27) — set by the adapter, never by `snapshot()`, which
   * has no floor to intersect against. Empty `components` alongside this marker
   * means the request fell outside the floor, not that the surface is empty.
   */
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
  capabilityId: string; // "view:devices.table.readState"
  name: string; // "readState"
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

export interface AgentProcedureDescriptor {
  procedureId: string; // "domain:devices.disable"
  /**
   * The manifest description. Stable across snapshots — the contextual
   * `describe()` output is `contextualNote`, not part of this string, unless
   * the registry was created with `snapshotMergesContextualNote: true`
   * (the 0.2 default, removed in a later minor — D28).
   */
  description: string;
  /**
   * Volatile: this snapshot's contextual `describe()` output, if any. Always
   * populated, in both merge modes, so a host can migrate before the default
   * moves. Use {@link stableDescriptionOf} to recover the note-free
   * description without parsing.
   */
  contextualNote?: string;
  /** Agent-facing (reduced) input schema per binding rule 1 (docs/05). */
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: AgentProcedureEffect;
  confirmation: ConfirmationLevel; // max(manifest, reference)
  available: boolean;
  unavailableReason?: string;
  boundFields: Array<{ path: string; locked: boolean; source: "ui-state" }>;
  /** The registration that contributed this reference (staleness token). */
  registrationId: string;
  /** Optional link to the owning view component. */
  context?: { type: string; instanceId: string };
  meta?: Record<string, JsonValue>;
}

export type AgentCapabilityDescriptorUnion =
  | AgentObservationDescriptor
  | AgentActionDescriptor
  | AgentProcedureDescriptor;

const DEFAULT_CONSUMER: AgentConsumer = { id: "anonymous", kind: "embedded" };

/**
 * The note-free description of a descriptor, whichever way the registry was
 * configured to compose it (D28). The merge rule is `${description} ${note}`,
 * so the split is exact — no host ever has to parse a prefix it did not write.
 */
export function stableDescriptionOf(descriptor: {
  description: string;
  contextualNote?: string;
}): string {
  const note = descriptor.contextualNote;
  if (!note) return descriptor.description;
  if (descriptor.description === note) return "";
  return descriptor.description.endsWith(` ${note}`)
    ? descriptor.description.slice(0, -(note.length + 1))
    : descriptor.description;
}

function matchesScope(type: string, scope: string[] | undefined): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.some((prefix) => type === prefix || type.startsWith(`${prefix}.`));
}

function sortRegistrations(regs: InternalRegistration[]): InternalRegistration[] {
  return regs.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;
  });
}

/**
 * Synchronous, side-effect-free catalog projection (docs/03 §snapshot, D5):
 * never runs read() handlers, never awaits, never serializes `internal`.
 */
export function createSnapshot(
  internals: RegistryInternals,
  ctx?: SnapshotContext,
): AgentSurfaceSnapshot {
  const consumer = ctx?.consumer ?? DEFAULT_CONSUMER;
  const includeUnavailable = ctx?.includeUnavailable ?? true;
  const host = internals.host();

  const regs = sortRegistrations(
    [...internals.registrations.values()].filter((r) => r.status === "active"),
  );

  const components: AgentComponentDescriptor[] = [];
  const componentPriority: number[] = [];
  const procedures: AgentProcedureDescriptor[] = [];

  for (const reg of regs) {
    const inScopeForComponents = matchesScope(reg.type, ctx?.scope);

    if (!reg.procedureOnly && inScopeForComponents) {
      const observations: AgentObservationDescriptor[] = [];
      const actions: AgentActionDescriptor[] = [];
      let definedCount = 0;
      let hiddenCount = 0;

      for (const obs of reg.observations.values()) {
        definedCount += 1;
        const chain = policiesFor(internals, reg, obs);
        const policyCtx = buildPolicyContext(internals, reg, obs, consumer, host);
        const decision = evaluateDiscovery(chain, policyCtx);
        if (decision.decision === "hide") {
          hiddenCount += 1;
          continue;
        }
        const availability = computeAvailability(internals, reg, obs);
        const available = availability.available && decision.decision === "expose";
        const reason =
          decision.decision === "disable" ? decision.reason : availability.reason;
        if (!available && !includeUnavailable) continue;
        observations.push({
          capabilityId: obs.capabilityId,
          name: obs.name,
          description: obs.description,
          outputSchema: obs.jsonSchema,
          available,
          ...(available ? {} : { unavailableReason: reason }),
          ...(obs.meta ? { meta: obs.meta } : {}),
        });
      }

      for (const act of reg.actions.values()) {
        definedCount += 1;
        const chain = policiesFor(internals, reg, act);
        const policyCtx = buildPolicyContext(internals, reg, act, consumer, host);
        const decision = evaluateDiscovery(chain, policyCtx);
        if (decision.decision === "hide") {
          hiddenCount += 1;
          continue;
        }
        const availability = computeAvailability(internals, reg, act);
        const available = availability.available && decision.decision === "expose";
        const reason =
          decision.decision === "disable" ? decision.reason : availability.reason;
        if (!available && !includeUnavailable) continue;
        actions.push({
          capabilityId: act.capabilityId,
          name: act.name,
          description: act.description,
          inputSchema: act.inputJsonSchema,
          ...(act.outputJsonSchema ? { outputSchema: act.outputJsonSchema } : {}),
          effect: act.effect,
          idempotent: act.idempotent,
          reversible: act.reversible,
          confirmation: act.confirmation,
          available,
          ...(available ? {} : { unavailableReason: reason }),
          ...(act.meta ? { meta: act.meta } : {}),
        });
      }

      // Deny-by-default: a component whose every capability is policy-hidden
      // is itself hidden (existence is information, docs/06).
      const allHidden = definedCount > 0 && hiddenCount === definedCount;
      if (!allHidden) {
        components.push({
          type: reg.type,
          instanceId: reg.instanceId,
          registrationId: reg.id,
          description: reg.description,
          ...(reg.parent ? { parent: reg.parent } : {}),
          ...(reg.meta ? { meta: reg.meta } : {}),
          observations,
          actions,
        });
        componentPriority.push(reg.priority);
      }
    }

    for (const proc of reg.procedures) {
      const scopeMatch = proc.contextLink
        ? matchesScope(proc.contextLink.type, ctx?.scope)
        : matchesScope(proc.path, ctx?.scope);
      if (!scopeMatch) continue;
      const chain = policiesFor(internals, reg, proc);
      const policyCtx = buildPolicyContext(internals, reg, proc, consumer, host);
      const decision = evaluateDiscovery(chain, policyCtx);
      if (decision.decision === "hide") continue;
      const availability = computeAvailability(internals, reg, proc);
      const available = availability.available && decision.decision === "expose";
      const reason = decision.decision === "disable" ? decision.reason : availability.reason;
      if (!available && !includeUnavailable) continue;
      // D28: the stable description and the volatile note are kept apart here,
      // and merged back only for hosts that have not migrated yet.
      let contextualNote: string | undefined;
      const describe = proc.binding.config.describe;
      if (describe) {
        try {
          const contextual = describe();
          if (contextual) contextualNote = contextual;
        } catch {
          /* describe() must not break the snapshot */
        }
      }
      const description =
        contextualNote && internals.mergesContextualNote
          ? `${proc.baseDescription} ${contextualNote}`.trim()
          : proc.baseDescription;
      procedures.push({
        procedureId: proc.capabilityId,
        description,
        ...(contextualNote !== undefined ? { contextualNote } : {}),
        inputSchema: proc.reducedInputSchema,
        ...(proc.outputJsonSchema ? { outputSchema: proc.outputJsonSchema } : {}),
        effect: proc.effect,
        confirmation: proc.confirmationFloor,
        available,
        ...(available ? {} : { unavailableReason: reason }),
        boundFields: proc.boundKeys.map((path) => ({
          path,
          locked: proc.lockedKeys.includes(path),
          source: "ui-state" as const,
        })),
        registrationId: reg.id,
        ...(proc.contextLink ? { context: proc.contextLink } : {}),
        ...(proc.meta ? { meta: proc.meta } : {}),
      });
    }
  }

  // Budgets (Experimental): drop lowest-priority components first, loudly.
  let dropped = 0;
  const budget = ctx?.budget;
  if (budget?.maxComponents !== undefined && components.length > budget.maxComponents) {
    dropped += components.length - budget.maxComponents;
    dropLowestPriority(components, componentPriority, components.length - budget.maxComponents);
  }
  if (budget?.maxBytes !== undefined) {
    while (components.length > 0 && byteLength(components) > budget.maxBytes) {
      dropLowestPriority(components, componentPriority, 1);
      dropped += 1;
    }
  }

  const snapshot: AgentSurfaceSnapshot = {
    surfaceId: internals.surfaceId,
    surfaceVersion: String(internals.version),
    capturedAt: new Date(internals.now()).toISOString(),
    ...(internals.routeFn?.() ? { route: internals.routeFn() } : {}),
    components,
    procedures,
    ...(dropped > 0 ? { truncated: { droppedComponents: dropped } } : {}),
  };
  return deepFreeze(snapshot);
}

function dropLowestPriority(
  components: AgentComponentDescriptor[],
  priorities: number[],
  count: number,
): void {
  for (let n = 0; n < count && components.length > 0; n++) {
    let lowestIndex = 0;
    for (let i = 1; i < priorities.length; i++) {
      if ((priorities[i] ?? 0) <= (priorities[lowestIndex] ?? 0)) lowestIndex = i;
    }
    components.splice(lowestIndex, 1);
    priorities.splice(lowestIndex, 1);
  }
}
