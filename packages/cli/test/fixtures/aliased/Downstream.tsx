import { action, fromJsonSchema } from "@agent-surface/core";
import { useAC } from "./Barrel.js";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * `useAC` here is imported from a local module, not from ours, so nothing at
 * this call site proves it is a registration. Attributing it on the strength of
 * a name would be a guess, and a guess that lands wrong fabricates a catalog
 * entry — worse than the missing one. The barrel reports instead.
 */
export function BarrelPanel(): React.ReactElement {
  useAC({
    type: "alias.barrel",
    description: "registered through a renaming barrel",
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
