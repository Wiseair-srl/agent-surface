import { action, observation, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/** Authored *and* reached: the config's only scenario renders this one. */
export function Mounted(): React.ReactElement {
  useAgentComponent({
    type: "cov.mounted",
    description: "a component the scenario renders",
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
