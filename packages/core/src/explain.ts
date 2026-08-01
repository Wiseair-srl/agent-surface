/**
 * `explainSurface()` — the developer projection.
 *
 * `snapshot()` answers "what may this agent call right now". It bakes policy
 * *outcomes*: a `hide` decision deletes the capability outright, leaving no
 * trace of which policy did it. That is correct for the agent boundary — the
 * existence of a hidden capability is itself information (docs/06) — and it is
 * exactly wrong for the developer staring at a surface that is missing a
 * capability they know they registered.
 *
 * This module answers the other question: *why*. It reports every capability
 * the registry holds, including the ones the snapshot omits, each with the
 * policy chain that judged it and that chain's per-policy votes.
 *
 * ## This is never agent-facing
 *
 * It lives behind its own entry point (`@agent-surface/core/explain`) and is
 * deliberately absent from the package root, so no adapter can reach it by
 * importing `@agent-surface/core` (AS-EXPLAIN-004). Nothing here may be piped
 * into a toolset, a transport, or a model prompt: doing so re-leaks precisely
 * the existence that `hide` exists to withhold. Developer tools, tests, and
 * CLIs only.
 */
import type { AgentConsumer, AgentRouteInfo } from "./types.js";
import type { AgentSurfaceRegistry } from "./registry.js";
import type { DiscoveryDecision, AgentPolicy, AgentPolicyContext } from "./policy.js";
import { CONFIRMATION_ESCALATION, type AgentPolicyWithEscalation } from "./policy.js";
import {
  INTERNALS,
  buildPolicyContext,
  computeAvailability,
  type CapabilityRuntime,
  type InternalRegistration,
  type InternalsCarrier,
  type RegistryInternals,
} from "./internal.js";
import { DEFAULT_CONSUMER, matchesScope, sortRegistrations, type SnapshotContext } from "./snapshot.js";
import { deepFreeze } from "./utils.js";

/** Which layer of the chain contributed a policy (docs/06 §composition). */
/**
 * Re-exported for developer tooling that has to line a *static* view of the
 * codebase up with a scoped projection — `@agent-surface/cli`'s coverage join,
 * where an authored capability outside the active scope must not be reported as
 * one no scenario reaches. A second copy of this predicate would drift, and the
 * drift would present as a false finding.
 *
 * It lives on this subpath rather than the package root for the reason
 * `AS-EXPLAIN-004` gives: the root is the agent-facing API, and this is not
 * part of the agent contract.
 */
export { matchesScope } from "./snapshot.js";

export type PolicyScope = "registry" | "component" | "capability";

export interface PolicyAttribution {
  /** `AgentPolicy.name` — built-ins are `authenticated`, `rate-limit`, … */
  name: string;
  scope: PolicyScope;
  /** Which pipeline hooks this policy implements. */
  phases: Array<"discovery" | "authorize" | "invoke">;
  /** This policy's own vote. Absent when it has no `onDiscovery`. */
  discovery?: DiscoveryDecision;
  /**
   * `onDiscovery` threw. `evaluateDiscovery` fails closed, so the vote is
   * recorded as `hide` — but a throwing discovery policy is a defect, and the
   * snapshot alone cannot tell you it happened.
   */
  threw?: boolean;
  /** Carries the `requireConfirmation` escalation marker. */
  confirmationEscalation?: boolean;
}

export interface CapabilityExplanation {
  capabilityId: string;
  kind: "observation" | "action" | "procedure";
  plane: "view" | "domain";
  /**
   * The manifest description. Carried here because a hidden capability has no
   * snapshot entry to read it from, and an id alone does not tell a developer
   * which of their capabilities went missing.
   */
  description: string;
  registrationId: string;
  component: { type: string; instanceId: string };
  /**
   * What `snapshot()` did with this capability for the same context:
   * `hide` means absent from the snapshot entirely.
   */
  outcome: "expose" | "disable" | "hide";
  /** The reason a non-exposed capability carries, matching the snapshot's. */
  reason?: string;
  /** The full chain, registry-outermost first — the order policies run in. */
  policies: PolicyAttribution[];
  /**
   * The `when()`/override verdict on its own. Authority hides, state discloses
   * (D11/D12): keeping these apart is what lets you tell "a policy removed it"
   * from "the UI says not right now".
   */
  availability: { available: boolean; reason?: string };
}

export interface SurfaceExplanation {
  surfaceId: string;
  surfaceVersion: string;
  capturedAt: string; // ISO-8601
  route?: AgentRouteInfo;
  /** The consumer this explanation was computed for. */
  consumer: AgentConsumer;
  /** Every capability held by the registry, hidden ones included. */
  capabilities: CapabilityExplanation[];
}

function phasesOf(policy: AgentPolicy): Array<"discovery" | "authorize" | "invoke"> {
  const phases: Array<"discovery" | "authorize" | "invoke"> = [];
  if (policy.onDiscovery) phases.push("discovery");
  if (policy.onAuthorize) phases.push("authorize");
  if (policy.onInvoke) phases.push("invoke");
  return phases;
}

/**
 * Per-policy attribution plus the composed decision.
 *
 * `evaluateDiscovery` short-circuits on the first `hide`, so it cannot be
 * reused here — we need every vote, not the verdict. The composition below is
 * a faithful restatement of it (first `hide` wins; otherwise the *first*
 * `disable` is kept; otherwise `expose`), and AS-EXPLAIN-003 pins the two
 * together against a real snapshot. Re-running `onDiscovery` is safe by
 * contract: it MUST be synchronous, cheap, and side-effect free (docs/06).
 */
function attribute(
  chain: AgentPolicy[],
  boundaries: { registry: number; component: number },
  ctx: AgentPolicyContext,
): { policies: PolicyAttribution[]; decision: DiscoveryDecision } {
  const policies: PolicyAttribution[] = [];
  let hidden = false;
  let disable: { decision: "disable"; reason: string } | undefined;

  chain.forEach((policy, index) => {
    const scope: PolicyScope =
      index < boundaries.registry
        ? "registry"
        : index < boundaries.registry + boundaries.component
          ? "component"
          : "capability";

    const attribution: PolicyAttribution = {
      name: policy.name,
      scope,
      phases: phasesOf(policy),
    };
    if ((policy as AgentPolicyWithEscalation)[CONFIRMATION_ESCALATION]) {
      attribution.confirmationEscalation = true;
    }

    if (policy.onDiscovery) {
      let decision: DiscoveryDecision;
      try {
        decision = policy.onDiscovery(ctx);
      } catch {
        decision = { decision: "hide" }; // fail closed, exactly as evaluateDiscovery does
        attribution.threw = true;
      }
      attribution.discovery = decision;
      if (decision.decision === "hide") hidden = true;
      else if (decision.decision === "disable" && !disable) disable = decision;
    }

    policies.push(attribution);
  });

  return {
    policies,
    decision: hidden ? { decision: "hide" } : (disable ?? { decision: "expose" }),
  };
}

function explainCapability(
  internals: RegistryInternals,
  reg: InternalRegistration,
  cap: CapabilityRuntime,
  consumer: AgentConsumer,
  host: Record<string, unknown>,
): CapabilityExplanation {
  const chain = [...internals.registryPolicies, ...reg.componentPolicies, ...cap.policies];
  const ctx = buildPolicyContext(internals, reg, cap, consumer, host);
  const { policies, decision } = attribute(
    chain,
    { registry: internals.registryPolicies.length, component: reg.componentPolicies.length },
    ctx,
  );
  const availability = computeAvailability(internals, reg, cap);

  // Mirrors createSnapshot exactly: a policy `disable` reason wins over the
  // availability reason, and availability only matters once discovery exposed.
  const available = availability.available && decision.decision === "expose";
  const reason = decision.decision === "disable" ? decision.reason : availability.reason;
  const outcome: CapabilityExplanation["outcome"] =
    decision.decision === "hide" ? "hide" : available ? "expose" : "disable";

  return {
    capabilityId: cap.capabilityId,
    kind: cap.kind,
    plane: cap.kind === "procedure" ? "domain" : "view",
    description: cap.kind === "procedure" ? cap.baseDescription : cap.description,
    registrationId: reg.id,
    component: { type: reg.type, instanceId: reg.instanceId },
    outcome,
    ...(outcome === "expose" ? {} : reason !== undefined ? { reason } : {}),
    policies,
    availability: {
      available: availability.available,
      ...(availability.reason !== undefined ? { reason: availability.reason } : {}),
    },
  };
}

/**
 * Developer projection of the surface: every capability, hidden included, with
 * the policy chain that judged it.
 *
 * Honours `ctx.scope` and `ctx.consumer` so it lines up with the snapshot you
 * are debugging. `includeUnavailable` and `budget` are ignored by design —
 * withholding from an explanation is the one thing it must never do.
 *
 * @throws if `registry` was not produced by `createAgentSurfaceRegistry`, or
 * has been disposed.
 */
export function explainSurface(
  registry: AgentSurfaceRegistry,
  ctx?: SnapshotContext,
): SurfaceExplanation {
  const internals = (registry as unknown as InternalsCarrier)[INTERNALS];
  if (!internals) {
    throw new Error(
      "explainSurface() requires a registry created by createAgentSurfaceRegistry()",
    );
  }
  if (internals.disposed) throw new Error("explainSurface() called on a disposed registry");

  const consumer = ctx?.consumer ?? DEFAULT_CONSUMER;
  const host = internals.host();
  const regs = sortRegistrations(
    [...internals.registrations.values()].filter((r) => r.status === "active"),
  );

  const capabilities: CapabilityExplanation[] = [];
  for (const reg of regs) {
    if (!reg.procedureOnly && matchesScope(reg.type, ctx?.scope)) {
      for (const obs of reg.observations.values()) {
        capabilities.push(explainCapability(internals, reg, obs, consumer, host));
      }
      for (const act of reg.actions.values()) {
        capabilities.push(explainCapability(internals, reg, act, consumer, host));
      }
    }
    for (const proc of reg.procedures) {
      const inScope = proc.contextLink
        ? matchesScope(proc.contextLink.type, ctx?.scope)
        : matchesScope(proc.path, ctx?.scope);
      if (!inScope) continue;
      capabilities.push(explainCapability(internals, reg, proc, consumer, host));
    }
  }

  const route = internals.routeFn?.();
  return deepFreeze({
    surfaceId: internals.surfaceId,
    surfaceVersion: String(internals.version),
    capturedAt: new Date(internals.now()).toISOString(),
    ...(route ? { route } : {}),
    consumer,
    capabilities,
  });
}
