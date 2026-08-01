import { createAgentSurfaceRegistry, action, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

/**
 * The silent failure `AS-CLI-006` exists for: a component rendered twice with no
 * `instanceId`. The second registration collides on `(type, instanceId)`, the
 * registry rejects it first-wins and hands back a dead handle, and the only
 * diagnostic goes through `devError` — which prints nothing here, because this
 * app is built `environment: "test"` exactly as the documented config shape
 * builds it.
 *
 * Before the collector read the event stream, the whole event was invisible:
 * absent from the snapshot (never registered), absent from the explanation
 * (`explainSurface` iterates active registrations), and absent from `check`
 * (the baseline never contained it, so there is no drift).
 */
function Panel(): React.ReactElement {
  useAgentComponent({
    type: "dup.panel",
    description: "a panel rendered twice, on purpose",
    actions: {
      ping: action({
        description: "does nothing, observably",
        input: fromJsonSchema<Record<string, never>>({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        effect: "local-state" as const,
        execute: () => ({ ok: true }),
      }),
    },
  });
  return <div />;
}

export default {
  mount: () => ({
    registry: createAgentSurfaceRegistry({ environment: "test" }),
    ui: (
      <>
        <Panel />
        <Panel />
      </>
    ),
  }),
  scenarios: { default: {} },
};
