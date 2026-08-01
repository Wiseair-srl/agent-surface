import { action, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

function componentType(): string {
  return "cov.dynamic";
}

/**
 * The call site the extractor cannot read (`AS-COVER-002`). `type` is computed,
 * so no capability id here is determined by source text.
 *
 * The requirement is that this is **reported with its file and line**, never
 * quietly skipped. An inventory that dropped what it failed to parse would
 * understate the denominator, and every coverage number built on it would claim
 * a completeness it never had.
 */
export function Dynamic(): React.ReactElement {
  useAgentComponent({
    type: componentType(),
    description: "a component whose type is not a literal",
    actions: {
      go: action({
        description: "goes",
        input: empty,
        effect: "local-state",
        execute: () => ({}),
      }),
    },
  });
  return <div />;
}
