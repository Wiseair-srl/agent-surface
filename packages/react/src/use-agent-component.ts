import { useEffect, useRef, useState } from "react";
import { COMPILED_CAPABILITY_PROVENANCE } from "@agent-surface/core";
import type {
  AgentActionContext,
  AgentActionDefinition,
  AgentComponentDefinition,
  AgentObservationDefinition,
  AgentReadContext,
  AgentRegistrationHandle,
  AgentComponentContract,
  AgentComponentRuntimeBindings,
  JsonValue,
} from "@agent-surface/core";
import { useAgentSurface } from "./context.js";
import { setRenderScopeContext } from "./render-scope.js";

export interface UseAgentComponentConfig
  extends Omit<AgentComponentDefinition, "procedures"> {
  /**
   * Gate for "mounted but not presented" (inactive tab, keep-alive, exit
   * animation). false ⇒ all capabilities visible-disabled. Default true.
   */
  enabled?: boolean;
}

export interface AgentComponentHandle {
  /** Current registrationId; changes on remount/re-register. */
  registrationId: string | undefined;
  status: "active" | "rejected" | "unregistered" | "pending";
}

/**
 * One aggregated hook per agent component (docs/04, the recommended default):
 * one registration, one atomic descriptor, one lifecycle.
 *
 * Registration happens once per mount, in an effect; handlers are read through
 * a ref at invocation time (D3) — no dependency arrays, no useCallback, no
 * stale closures. Structure is frozen per registration (D2): changing it on a
 * live registration logs an error and re-registers.
 */
export function useAgentComponent<
  TObservations extends Record<string, any>,
  TActions extends Record<string, any>,
>(
  contract: AgentComponentContract<TObservations, TActions>,
  bindings: AgentComponentRuntimeBindings<TObservations, TActions>,
): AgentComponentHandle;
/** @deprecated Use a compiler-generated contract plus runtime bindings. */
export function useAgentComponent(config: UseAgentComponentConfig): AgentComponentHandle;
export function useAgentComponent<
  TObservations extends Record<string, any>,
  TActions extends Record<string, any>,
>(
  contractOrConfig: AgentComponentContract<TObservations, TActions> | UseAgentComponentConfig,
  runtimeBindings?: AgentComponentRuntimeBindings<TObservations, TActions>,
): AgentComponentHandle {
  const config: UseAgentComponentConfig =
    "kind" in contractOrConfig && contractOrConfig.kind === "agent-component-contract"
      ? contractOrConfig.bind(
          (runtimeBindings ?? {}) as AgentComponentRuntimeBindings<TObservations, TActions>,
        ) as UseAgentComponentConfig
      : contractOrConfig;
  const registry = useAgentSurface();
  const type = config.type;
  const instanceId = config.instanceId ?? "default";

  // D3 latest-ref: every render writes the fresh config; the registered
  // definition's handlers delegate through it at invocation time.
  const latest = useRef(config);
  latest.current = config;

  // Record the render-scope link for a following useAgentProcedure call.
  setRenderScopeContext({ type, instanceId });

  const [nonce, setNonce] = useState(0);
  const handleRef = useRef<AgentRegistrationHandle | null>(null);
  const fingerprintRef = useRef<string | null>(null);
  const lastPushedAvailability = useRef<Record<string, { available: boolean; reason?: string }>>({});
  const lastPushedEnabled = useRef<boolean | null>(null);
  const [state, setState] = useState<AgentComponentHandle>({
    registrationId: undefined,
    status: "pending",
  });

  useEffect(() => {
    const definition = buildDelegatingDefinition(latest);
    const handle = registry.register(definition);
    handleRef.current = handle;
    fingerprintRef.current = structuralFingerprint(latest.current);
    lastPushedAvailability.current = {};
    lastPushedEnabled.current = latest.current.enabled !== false;
    const registrationId = handle.status === "active" ? handle.registrationId : undefined;
    const status = handle.status === "active" ? "active" : "rejected";
    setState((prev) =>
      prev.registrationId === registrationId && prev.status === status
        ? prev
        : { registrationId, status },
    );
    if (handle.status === "active") {
      pushAvailability(handle, latest.current, lastPushedAvailability, lastPushedEnabled);
    }
    return () => {
      handle.unregister();
      handleRef.current = null;
      fingerprintRef.current = null;
    };
    // Identity keys: (registry, type, instanceId) + explicit re-register nonce.
  }, [registry, type, instanceId, nonce]);

  // Availability is reactive (docs/04): re-evaluated on every commit and
  // PUSHED on change, so the surface version bumps and adapters refresh.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || handle.status !== "active") return;
    const fingerprint = structuralFingerprint(latest.current);
    if (fingerprintRef.current !== null && fingerprint !== fingerprintRef.current) {
      // Structural change on a live registration violates D2. Re-register so
      // the surface never lies about what this registrationId can do.
      // eslint-disable-next-line no-console
      console.error(
        `[agent-surface] structural config change detected on live registration "${type}" (${instanceId}). ` +
          "Structure (names, schemas, descriptions, effects, policies) is frozen per registration (D2); " +
          "keep it static per mount and put dynamism in when/enabled/handlers. Re-registering with a new registrationId.",
      );
      setNonce((n) => n + 1);
      return;
    }
    pushAvailability(handle, latest.current, lastPushedAvailability, lastPushedEnabled);
  });

  return state;
}

/* ────────────────────────────── internals ────────────────────────────── */

type LatestRef = { current: UseAgentComponentConfig };

function buildDelegatingDefinition(latest: LatestRef): AgentComponentDefinition {
  const cfg = latest.current;
  const observations: Record<string, AgentObservationDefinition<any>> = {};
  for (const [name, obs] of Object.entries(cfg.observations ?? {})) {
    observations[name] = {
      description: obs.description,
      output: obs.output,
      read: (ctx: AgentReadContext) => {
        const live = latest.current.observations?.[name];
        if (!live) throw new Error(`observation "${name}" disappeared from the config`);
        return live.read(ctx);
      },
      ...(obs.when !== undefined
        ? { when: () => latest.current.observations?.[name]?.when?.() !== false }
        : {}),
      ...(obs.unavailableReason !== undefined
        ? {
            unavailableReason: () =>
              evaluateReason(latest.current.observations?.[name]?.unavailableReason),
          }
        : {}),
      ...(obs.policies ? { policies: obs.policies } : {}),
      ...(obs.meta ? { meta: obs.meta } : {}),
      ...(obs.timeoutMs !== undefined ? { timeoutMs: obs.timeoutMs } : {}),
    };
  }
  const actions: Record<string, AgentActionDefinition<any, any>> = {};
  for (const [name, act] of Object.entries(cfg.actions ?? {})) {
    actions[name] = {
      description: act.description,
      input: act.input,
      ...(act.output ? { output: act.output } : {}),
      effect: act.effect,
      ...(act.idempotent !== undefined ? { idempotent: act.idempotent } : {}),
      ...(act.reversible !== undefined ? { reversible: act.reversible } : {}),
      ...(act.confirmation !== undefined ? { confirmation: act.confirmation } : {}),
      ...(act.audit !== undefined ? { audit: act.audit } : {}),
      ...(act.when !== undefined
        ? { when: () => latest.current.actions?.[name]?.when?.() !== false }
        : {}),
      ...(act.unavailableReason !== undefined
        ? {
            unavailableReason: () =>
              evaluateReason(latest.current.actions?.[name]?.unavailableReason),
          }
        : {}),
      ...(act.precondition !== undefined
        ? {
            precondition: (input: JsonValue, ctx: AgentReadContext) =>
              latest.current.actions?.[name]?.precondition?.(input, ctx),
          }
        : {}),
      execute: (input: JsonValue, ctx: AgentActionContext) => {
        const live = latest.current.actions?.[name];
        if (!live) throw new Error(`action "${name}" disappeared from the config`);
        return live.execute(input, ctx);
      },
      ...(act.policies ? { policies: act.policies } : {}),
      ...(act.meta ? { meta: act.meta } : {}),
      ...(act.timeoutMs !== undefined ? { timeoutMs: act.timeoutMs } : {}),
    };
  }
  const definition: AgentComponentDefinition = {
    type: cfg.type,
    ...(cfg.instanceId !== undefined ? { instanceId: cfg.instanceId } : {}),
    description: cfg.description,
    ...(cfg.parent ? { parent: cfg.parent } : {}),
    ...(cfg.meta ? { meta: cfg.meta } : {}),
    ...(cfg.internal ? { internal: cfg.internal } : {}),
    ...(cfg.policies ? { policies: cfg.policies } : {}),
    ...(cfg.origin !== undefined ? { origin: cfg.origin } : {}),
    ...(cfg.priority !== undefined ? { priority: cfg.priority } : {}),
    ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
    ...(Object.keys(observations).length > 0 ? { observations } : {}),
    ...(Object.keys(actions).length > 0 ? { actions } : {}),
  };
  const provenance = (cfg as UseAgentComponentConfig & {
    [COMPILED_CAPABILITY_PROVENANCE]?: unknown;
  })[COMPILED_CAPABILITY_PROVENANCE];
  if (provenance) {
    Object.defineProperty(definition, COMPILED_CAPABILITY_PROVENANCE, {
      value: provenance,
      enumerable: false,
    });
  }
  return definition;
}

function evaluateReason(
  reason: string | (() => string) | undefined,
): string {
  try {
    if (typeof reason === "function") return reason();
    if (typeof reason === "string") return reason;
  } catch {
    /* fall through */
  }
  return "Currently unavailable";
}

/** Structural fingerprint per D2 (handlers and when() results excluded). */
function structuralFingerprint(cfg: UseAgentComponentConfig): string {
  const capability = (
    def:
      | AgentObservationDefinition<any>
      | AgentActionDefinition<any, any>,
  ): unknown => ({
    description: def.description,
    output: "output" in def && def.output ? def.output.jsonSchema : undefined,
    input: "input" in def ? def.input.jsonSchema : undefined,
    effect: "effect" in def ? def.effect : undefined,
    idempotent: "idempotent" in def ? def.idempotent : undefined,
    reversible: "reversible" in def ? def.reversible : undefined,
    confirmation: "confirmation" in def ? def.confirmation : undefined,
    audit: "audit" in def ? def.audit : undefined,
    timeoutMs: def.timeoutMs,
    hasWhen: def.when !== undefined,
    hasPrecondition: "precondition" in def && def.precondition !== undefined,
    policies: (def.policies ?? []).map((p) => p.name),
  });
  return JSON.stringify({
    type: cfg.type,
    instanceId: cfg.instanceId ?? "default",
    description: cfg.description,
    parent: cfg.parent,
    meta: cfg.meta,
    origin: cfg.origin,
    priority: cfg.priority,
    policies: (cfg.policies ?? []).map((p) => p.name),
    observations: Object.fromEntries(
      Object.entries(cfg.observations ?? {}).map(([name, def]) => [name, capability(def)]),
    ),
    actions: Object.fromEntries(
      Object.entries(cfg.actions ?? {}).map(([name, def]) => [name, capability(def)]),
    ),
  });
}

function pushAvailability(
  handle: AgentRegistrationHandle,
  cfg: UseAgentComponentConfig,
  lastPushed: { current: Record<string, { available: boolean; reason?: string }> },
  lastEnabled: { current: boolean | null },
): void {
  const patch: {
    enabled?: boolean;
    availability?: Record<string, { available: boolean; reason?: string }>;
  } = {};

  const enabled = cfg.enabled !== false;
  if (lastEnabled.current !== enabled) {
    patch.enabled = enabled;
    lastEnabled.current = enabled;
  }

  const availability: Record<string, { available: boolean; reason?: string }> = {};
  const evaluate = (
    name: string,
    def: { when?: () => boolean; unavailableReason?: string | (() => string) },
  ): void => {
    if (!def.when) return; // no predicate ⇒ availability governed by enabled only
    let available = true;
    try {
      available = def.when() !== false;
    } catch {
      available = false;
    }
    const entry = available
      ? { available: true as const }
      : { available: false as const, reason: evaluateReason(def.unavailableReason) };
    const prev = lastPushed.current[name];
    if (!prev || prev.available !== entry.available || prev.reason !== entry.reason) {
      availability[name] = entry;
      lastPushed.current[name] = entry;
    }
  };
  for (const [name, def] of Object.entries(cfg.observations ?? {})) evaluate(name, def);
  for (const [name, def] of Object.entries(cfg.actions ?? {})) evaluate(name, def);

  if (Object.keys(availability).length > 0) patch.availability = availability;
  if (patch.enabled !== undefined || patch.availability) handle.update(patch);
}
