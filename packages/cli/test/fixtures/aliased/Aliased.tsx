import { action, observation, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent as useAC } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * The reported shape: the same hook, under a different local name. Identified
 * by the local identifier alone, this registration was in *neither* list — no
 * capability in the catalog, and no unread call site saying one was missing.
 * The one place this extractor under-reported silently.
 */
export function AliasedPanel(): React.ReactElement {
  useAC({
    type: "alias.panel",
    description: "registered through an aliased named import",
    observations: {
      read: observation({ description: "reads the panel", output: empty, read: () => ({}) }),
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
