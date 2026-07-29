import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentActionDefinition,
  AgentObservationDefinition,
  JsonValue,
} from "@agent-surface/core";
import { useAgentComponent, type UseAgentComponentConfig } from "./use-agent-component.js";

/**
 * Granular composition — Experimental (docs/04): capabilities contributed
 * from separate files/subcomponents. Late-added capabilities are structural
 * changes, so each attach/detach re-registers the scope (new registrationId).
 * The aggregated useAgentComponent hook remains the recommended default.
 */

interface ScopeStore {
  observations: Map<string, AgentObservationDefinition<any>>;
  actions: Map<string, AgentActionDefinition<any, any>>;
  bump(): void;
  add(kind: "observation" | "action", name: string, def: unknown): () => void;
}

const ScopeContext = createContext<ScopeStore | null>(null);

export interface AgentComponentScopeProps {
  config: Omit<UseAgentComponentConfig, "observations" | "actions">;
  children: ReactNode;
}

/** Establishes a component scope; children attach capabilities to it. */
export function AgentComponentScope(props: AgentComponentScopeProps): ReactNode {
  const [, setVersion] = useState(0);
  const store = useMemo<ScopeStore>(() => {
    const observations = new Map<string, AgentObservationDefinition<any>>();
    const actions = new Map<string, AgentActionDefinition<any, any>>();
    const bump = (): void => setVersion((v) => v + 1);
    return {
      observations,
      actions,
      bump,
      add(kind, name, def) {
        const map = kind === "observation" ? observations : actions;
        map.set(name, def as never);
        bump();
        return () => {
          map.delete(name);
          bump();
        };
      },
    };
  }, []);

  return createElement(
    ScopeContext.Provider,
    { value: store },
    createElement(ScopeRegistrar, { store, config: props.config }),
    props.children,
  );
}

function ScopeRegistrar(props: {
  store: ScopeStore;
  config: Omit<UseAgentComponentConfig, "observations" | "actions">;
}): null {
  // Child effects run before this parent effect, so attachments within one
  // commit are coalesced into a single (re-)registration.
  useAgentComponent({
    ...props.config,
    observations: Object.fromEntries(props.store.observations),
    actions: Object.fromEntries(props.store.actions),
  });
  return null;
}

function useScope(hook: string): ScopeStore {
  const store = useContext(ScopeContext);
  if (!store) {
    throw new Error(`${hook} must be used inside an <AgentComponentScope>`);
  }
  return store;
}

export function useAgentAction<TIn extends JsonValue, TOut extends JsonValue | void = void>(
  name: string,
  def: AgentActionDefinition<TIn, TOut>,
): void {
  const store = useScope("useAgentAction");
  // Keep the stored definition fresh without re-registering (D3 handlers are
  // read through the aggregated hook's latest-ref at invocation time).
  if (store.actions.has(name)) store.actions.set(name, def as AgentActionDefinition<any, any>);
  useEffect(() => store.add("action", name, def), [store, name]);
}

export function useAgentObservation<TOut extends JsonValue>(
  name: string,
  def: AgentObservationDefinition<TOut>,
): void {
  const store = useScope("useAgentObservation");
  if (store.observations.has(name)) {
    store.observations.set(name, def as AgentObservationDefinition<any>);
  }
  useEffect(() => store.add("observation", name, def), [store, name]);
}
