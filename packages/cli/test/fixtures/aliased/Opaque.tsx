import { action, fromJsonSchema } from "@agent-surface/core";
import * as AS from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const hook = "useAgentComponent";

/**
 * The namespace is provably ours and the member is not readable, so *which*
 * export is called is unknown here. TypeScript resolves it through the `const`;
 * this extractor has no checker and will not pretend otherwise.
 *
 * Knowing the module is ours is exactly what makes this reportable: an
 * unreadable call on some other object is not a registration at all.
 */
export function ComputedMember(): React.ReactElement {
  AS[hook]({
    type: "alias.computed",
    description: "called through a computed member of our namespace",
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
