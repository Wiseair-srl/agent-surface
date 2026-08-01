import { action, observation, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/**
 * The shape from #31: one wrapper, many call sites, each passing a string
 * literal `type` straight through. Reported unread, this single line hides
 * every capability every caller authors.
 */
export function usePanel(type: string): void {
  useAgentComponent({
    type,
    description: "a panel registered through a shared wrapper",
    observations: {
      read: observation({ description: "reads the panel", output: empty, read: () => ({}) }),
    },
    actions: {
      poke: action({ description: "pokes", input: empty, effect: "local-state", execute: () => ({}) }),
    },
  });
}

/** The destructured spelling, which is just as common. */
export function useNamedPanel({ type }: { type: string }): void {
  useAgentComponent({
    type,
    description: "destructured type",
    observations: {
      read: observation({ description: "reads", output: empty, read: () => ({}) }),
    },
  });
}
