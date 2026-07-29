/**
 * Best-effort render-scope link between useAgentComponent and a following
 * useAgentProcedure in the SAME component function (docs/05): the component
 * hook records its identity during render; the procedure hook reads it.
 *
 * React exposes no public per-instance identity shared across independent
 * hook calls, so this is a heuristic: it is precise for the canonical
 * pattern (both hooks in one component) and clears itself at the end of the
 * synchronous render pass. A sibling component rendering later in the same
 * pass with only useAgentProcedure may pick up a stale link — cosmetic only
 * (the link is descriptor metadata, never authority).
 */

export interface RenderScopeContext {
  type: string;
  instanceId: string;
}

interface Slot {
  context: RenderScopeContext;
  token: object;
}

let current: Slot | null = null;

export function setRenderScopeContext(context: RenderScopeContext): void {
  const token = {};
  current = { context, token };
  queueMicrotask(() => {
    if (current?.token === token) current = null;
  });
}

export function readRenderScopeContext(): RenderScopeContext | undefined {
  return current?.context;
}
