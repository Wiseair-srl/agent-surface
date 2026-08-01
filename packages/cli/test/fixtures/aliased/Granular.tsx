import { action, fromJsonSchema } from "@agent-surface/core";
import { useAgentAction as useAA } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * A granular hook under an alias. Its component `type` is not at this call site
 * either way (OQ-13), so the answer is still an unread entry — but it has to be
 * *reached* to be reported, and matching on the local name never reached it.
 */
export function AliasedAction(): React.ReactElement {
  useAA(
    "poke",
    action({ description: "pokes", input: empty, effect: "local-state", execute: () => {} }),
  );
  return <div />;
}
