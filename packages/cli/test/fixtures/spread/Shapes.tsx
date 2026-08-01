import { action, observation, fromJsonSchema } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

const empty = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

function buildMembers() {
  return {
    observations: {
      readState: observation({
        description: "built by a helper",
        output: empty,
        read: () => ({}),
      }),
    },
  };
}

/**
 * The reported shape (#29): `type` is a literal, but every member arrives
 * through a spread whose contents the extractor cannot read. Nothing is
 * enumerable, so the whole registration has to be reported unread.
 */
export function SpreadAll(): React.ReactElement {
  useAgentComponent({
    type: "spread.all",
    description: "literal type, members spread from a helper",
    ...buildMembers(),
  });
  return <div />;
}

/**
 * The same hole, half-masked — and the ordering TypeScript is happy with. The
 * spread comes first, so the literal `observations` below wins and TS2783 never
 * fires; but the spread may still contribute `actions`, and those are invisible.
 * The half that resolves must not be read as the whole.
 */
export function SpreadSome(): React.ReactElement {
  useAgentComponent({
    type: "spread.some",
    description: "spread first, literal observations after — actions may still be hidden",
    ...buildMembers(),
    observations: {
      read: observation({ description: "literal", output: empty, read: () => ({}) }),
    },
  });
  return <div />;
}

/**
 * The documented common case, and the one that must stay quiet: the spread's
 * key set is statically apparent and cannot contain a capability group.
 */
export function SpreadInstanceId(props: { instance?: string }): React.ReactElement {
  useAgentComponent({
    type: "spread.instance",
    description: "conditional instanceId, the shape every example uses",
    ...(props.instance ? { instanceId: props.instance } : {}),
    actions: {
      poke: action({ description: "literal", input: empty, effect: "local-state", execute: () => ({}) }),
    },
  });
  return <div />;
}
