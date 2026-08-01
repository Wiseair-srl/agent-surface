import { action, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * The finding `coverage` exists for. Nothing imports this module, so no
 * scenario ever renders it, so it never registers — which means:
 *
 *  - it is absent from every snapshot (nothing to see);
 *  - it is absent from every explanation (`explainSurface` iterates active
 *    registrations, and this one never became active);
 *  - it is absent from every baseline, so `check` reports no drift.
 *
 * Only the static inventory knows it was written.
 */
export function Unmounted(): React.ReactElement {
  useAgentComponent({
    type: "cov.unmounted",
    description: "a component no scenario mounts",
    actions: {
      toCsv: action({
        description: "exports the current view",
        input: empty,
        effect: "local-state",
        execute: () => ({}),
      }),
    },
  });
  return <div />;
}
