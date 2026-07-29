import { useEffect, useRef, useState } from "react";
import type { AgentRegistrationHandle } from "@agent-surface/core";
import {
  useAgentSurface,
  unstable_readRenderScopeContext,
} from "@agent-surface/react";
import type { AgentProcedureRef } from "./bridge.js";
import { isBridgeRef } from "./bridge.js";
import { bindAgentProcedure, type AgentProcedureBindingConfig } from "./binding.js";

let hookInstanceCounter = 0;

/**
 * Declares that an EXISTING domain procedure is relevant in the current view,
 * optionally pre-filling inputs from UI state (docs/05). Lifecycle mirrors
 * useAgentComponent: registers in an effect, unregisters on unmount;
 * bind/when/describe are read through the latest ref (fresh at execution);
 * availability is pushed on change.
 *
 * A ref not backed by the manifest registers NOTHING — the manifest, produced
 * by the backend's orpc-agent configuration, is the exposure ceiling.
 */
export function useAgentProcedure<
  TIn extends object,
  TOut,
  TBound extends Partial<TIn> = Partial<TIn>,
>(ref: AgentProcedureRef<TIn, TOut>, config?: AgentProcedureBindingConfig<TIn, TBound>): void {
  const registry = useAgentSurface();

  const latestConfig = useRef(config);
  latestConfig.current = config;

  // Capture the render-scope link (owning useAgentComponent, when present)
  // during render; the registration effect uses the captured value.
  const contextLink = unstable_readRenderScopeContext();
  const contextRef = useRef(contextLink);
  contextRef.current = contextLink ?? contextRef.current;

  const instanceRef = useRef<string | null>(null);
  if (instanceRef.current === null) {
    hookInstanceCounter += 1;
    instanceRef.current = `ref-${hookInstanceCounter}`;
  }

  const handleRef = useRef<AgentRegistrationHandle | null>(null);
  const lastPushed = useRef<boolean | null>(null);
  const [, setStatus] = useState<"pending" | "active" | "rejected">("pending");

  const manifestBacked = isBridgeRef(ref);
  const refId = ref?.id;

  useEffect(() => {
    if (!manifestBacked) {
      // Exposure gating (docs/05): register nothing, say so loudly.
      // eslint-disable-next-line no-console
      console.error(
        `[agent-surface] useAgentProcedure: ref "${String(refId)}" is not backed by the orpc-agent manifest — registering nothing. The manifest is the exposure ceiling.`,
      );
      return;
    }

    const delegating: AgentProcedureBindingConfig<TIn, TBound> = {
      when: () => {
        const when = latestConfig.current?.when;
        return when ? when() !== false : true;
      },
      unavailableReason: () => {
        const reason = latestConfig.current?.unavailableReason;
        try {
          if (typeof reason === "function") return reason();
          if (typeof reason === "string") return reason;
        } catch {
          /* fall through */
        }
        return "Currently unavailable";
      },
      ...(latestConfig.current?.bind
        ? { bind: () => (latestConfig.current?.bind?.() ?? {}) as TBound }
        : {}),
      ...(latestConfig.current?.overridableFields
        ? { overridableFields: latestConfig.current.overridableFields }
        : {}),
      ...(latestConfig.current?.confirmation
        ? { confirmation: latestConfig.current.confirmation }
        : {}),
      ...(latestConfig.current?.policies ? { policies: latestConfig.current.policies } : {}),
      ...(latestConfig.current?.describe
        ? { describe: () => latestConfig.current?.describe?.() ?? "" }
        : {}),
      ...(latestConfig.current?.meta ? { meta: latestConfig.current.meta } : {}),
    };

    const binding = bindAgentProcedure(ref, delegating);
    if (contextRef.current) binding.contextLink = { ...contextRef.current };

    const handle = registry.register({
      // Procedure-only registration: excluded from snapshot.components.
      type: "orpc-ref",
      instanceId: instanceRef.current!,
      description: `Contextual reference to ${ref.path}`,
      procedures: [binding],
    });
    handleRef.current = handle;
    lastPushed.current = null;
    setStatus(handle.status === "active" ? "active" : "rejected");

    return () => {
      handle.unregister();
      handleRef.current = null;
    };
  }, [registry, refId, manifestBacked]);

  // Push availability when the `when` predicate flips (per commit).
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || handle.status !== "active" || !manifestBacked) return;
    const when = latestConfig.current?.when;
    let available = true;
    try {
      available = when ? when() !== false : true;
    } catch {
      available = false;
    }
    if (lastPushed.current === available) return;
    lastPushed.current = available;
    const reason = latestConfig.current?.unavailableReason;
    let reasonText: string | undefined;
    if (!available) {
      try {
        reasonText = typeof reason === "function" ? reason() : reason;
      } catch {
        reasonText = undefined;
      }
    }
    handle.update({
      availability: {
        [ref.path]: {
          available,
          ...(reasonText !== undefined ? { reason: reasonText } : {}),
        },
      },
    });
  });
}
