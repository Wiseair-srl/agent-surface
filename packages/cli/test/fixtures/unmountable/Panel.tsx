import { action, observation, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * Authored, and reached by the one scenario that mounts. Its point is that the
 * catalog still finds it — and the working scenario still renders — while the
 * *other* scenario throws.
 */
export function Panel(): React.ReactElement {
  useAgentComponent({
    type: "brk.panel",
    description: "a component the working scenario renders",
    observations: {
      read: observation({
        description: "reads nothing in particular",
        output: empty,
        read: () => ({}),
      }),
    },
    actions: {
      poke: action({
        description: "pokes",
        input: empty,
        effect: "local-state",
        execute: () => ({}),
      }),
    },
  });
  return <div />;
}
