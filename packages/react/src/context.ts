import { createContext, createElement, useContext, type ReactNode } from "react";
import type { AgentSurfaceRegistry } from "@agent-surface/core";

const AgentSurfaceContext = createContext<AgentSurfaceRegistry | null>(null);

export interface AgentSurfaceProviderProps {
  registry: AgentSurfaceRegistry;
  children: ReactNode;
}

/**
 * The application creates the registry ONCE (module scope or top-level
 * useState initializer) and passes it down — registry creation is where
 * environment, policies, audit and route wiring live (docs/04).
 */
export function AgentSurfaceProvider(props: AgentSurfaceProviderProps): ReactNode {
  return createElement(AgentSurfaceContext.Provider, { value: props.registry }, props.children);
}

/** Access the registry from context. Throws if no provider is mounted. */
export function useAgentSurface(): AgentSurfaceRegistry {
  const registry = useContext(AgentSurfaceContext);
  if (!registry) {
    throw new Error(
      "useAgentSurface: no <AgentSurfaceProvider> found above this component. Wrap your app in a provider with an explicitly created registry.",
    );
  }
  return registry;
}
