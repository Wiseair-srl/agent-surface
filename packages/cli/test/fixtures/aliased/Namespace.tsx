import { action, fromJsonSchema } from "@agent-surface/core";
import * as AS from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * The namespace spelling. It resolved before this fixture existed, but only
 * because the property name happened to be spelled like the hook — the same
 * coincidence would have attributed `anything.useAgentComponent()`. Now the
 * namespace binding is what proves it.
 */
export function NamespacePanel(): React.ReactElement {
  AS.useAgentComponent({
    type: "alias.namespace",
    description: "registered through a namespace import",
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
