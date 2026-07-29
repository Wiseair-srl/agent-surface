export { AgentSurfaceProvider, useAgentSurface } from "./context.js";
export type { AgentSurfaceProviderProps } from "./context.js";

export { useAgentComponent } from "./use-agent-component.js";
export type { UseAgentComponentConfig, AgentComponentHandle } from "./use-agent-component.js";

export { usePendingConfirmations } from "./confirmations.js";
export type { PendingConfirmationView } from "./confirmations.js";

export {
  AgentComponentScope,
  useAgentAction,
  useAgentObservation,
} from "./granular.js";
export type { AgentComponentScopeProps } from "./granular.js";

// Internal seam for @agent-surface/orpc/react (render-scope context link).
export {
  readRenderScopeContext as unstable_readRenderScopeContext,
  setRenderScopeContext as unstable_setRenderScopeContext,
} from "./render-scope.js";
export type { RenderScopeContext as UnstableRenderScopeContext } from "./render-scope.js";
