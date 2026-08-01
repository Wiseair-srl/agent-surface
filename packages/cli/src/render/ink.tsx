import type { ReactElement } from "react";
import { Box, Static, Text } from "ink";
import Spinner from "ink-spinner";
import type { CapabilityRow, CapabilityGroup, SurfaceView } from "./model.js";
import type { DiffEntry } from "../baseline.js";
import { formatValue } from "../baseline.js";

const OUTCOME = {
  expose: { mark: "●", color: "green" as const },
  disable: { mark: "◐", color: "yellow" as const },
  hide: { mark: "○", color: "red" as const },
};

export function Loading({ label }: { label: string }): ReactElement {
  return (
    <Text>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      {` ${label}`}
    </Text>
  );
}

function PolicyLine({
  policy,
}: {
  policy: NonNullable<CapabilityRow["policies"]>[number];
}): ReactElement {
  const vote = policy.discovery?.decision;
  const color = vote === "hide" ? "red" : vote === "disable" ? "yellow" : "green";
  return (
    <Box paddingLeft={6}>
      <Text dimColor>policy </Text>
      <Text bold>{policy.name}</Text>
      <Text dimColor>{` (${policy.scope}${policy.phases.length ? `, ${policy.phases.join("/")}` : ""}) `}</Text>
      {vote ? (
        <Text color={color}>
          {vote}
          {policy.discovery?.decision === "disable" ? ` — ${policy.discovery.reason}` : ""}
        </Text>
      ) : (
        <Text dimColor>no discovery hook</Text>
      )}
      {policy.threw ? <Text color="red" bold>{" THREW"}</Text> : null}
      {policy.confirmationEscalation ? (
        <Text color="magenta">{" escalates-confirmation"}</Text>
      ) : null}
    </Box>
  );
}

function Capability({ row }: { row: CapabilityRow }): ReactElement {
  const outcome = OUTCOME[row.outcome];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={outcome.color}>{`  ${outcome.mark} `}</Text>
        <Text bold>{row.name}</Text>
        {row.tags.length > 0 ? <Text dimColor>{`  ${row.tags.join(" · ")}`}</Text> : null}
      </Box>
      <Box paddingLeft={4}>
        <Text dimColor wrap="wrap">
          {row.description}
        </Text>
      </Box>
      {row.reason ? (
        <Box paddingLeft={4}>
          <Text color="yellow" wrap="wrap">{`⤷ ${row.reason}`}</Text>
        </Box>
      ) : null}
      {row.policies
        ? row.policies.length > 0
          ? row.policies.map((policy, index) => (
              <PolicyLine key={`${policy.name}-${index}`} policy={policy} />
            ))
          : [
              <Box key="none" paddingLeft={6}>
                <Text dimColor>policies: none</Text>
              </Box>,
            ]
        : null}
      {row.policies && row.availability && !row.availability.available ? (
        <Box paddingLeft={6}>
          <Text dimColor>{`availability: unavailable${
            row.availability.reason ? ` — ${row.availability.reason}` : ""
          }`}</Text>
        </Box>
      ) : null}
      {row.schemas?.input !== undefined ? (
        <Box paddingLeft={6}>
          <Text dimColor wrap="wrap">{`input: ${JSON.stringify(row.schemas.input)}`}</Text>
        </Box>
      ) : null}
      {row.schemas?.output !== undefined ? (
        <Box paddingLeft={6}>
          <Text dimColor wrap="wrap">{`output: ${JSON.stringify(row.schemas.output)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Group({ group }: { group: CapabilityGroup }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text backgroundColor="blueBright" color="black" bold>{` ${group.heading} `}</Text>
        <Text dimColor>{`  ${group.rows.length}`}</Text>
      </Box>
      {group.rows.map((row) => (
        <Capability key={`${row.capabilityId}-${row.name}`} row={row} />
      ))}
    </Box>
  );
}

/**
 * The header states everything the counts are relative to (`AS-CLI-007`): the
 * scenario, the route, and the scope when one is active — a scope filters both
 * projections, so an unqualified count reads as a claim about the whole surface.
 * `hidden` is unconditional here for the same reason it is in plain text.
 */
function Header({ view }: { view: SurfaceView }): ReactElement {
  return (
    <Box>
      <Text bold>{view.scenario}</Text>
      {view.route ? <Text dimColor>{`  ${view.route}`}</Text> : null}
      {view.scope && view.scope.length > 0 ? (
        <Text color="cyan">{`  scope ${view.scope.join(" ")}`}</Text>
      ) : null}
      <Text dimColor>{"  ·  "}</Text>
      <Text color="green">{`${view.counts.callable} callable`}</Text>
      <Text dimColor>{", "}</Text>
      <Text color="yellow">{`${view.counts.disabled} visible-disabled`}</Text>
      <Text dimColor>{", "}</Text>
      <Text color="red">{`${view.counts.hidden} hidden`}</Text>
      {view.rejections.length > 0 ? (
        <>
          <Text dimColor>{", "}</Text>
          <Text color="magenta">
            {`${view.rejections.length} registration${
              view.rejections.length === 1 ? "" : "s"
            } rejected`}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

/**
 * Rejected registrations (`AS-CLI-006`). A dead handle leaves no trace in either
 * projection, so without this block a copy-pasted component `type` removes a
 * capability and prints nothing anywhere.
 */
function Rejections({ view }: { view: SurfaceView }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text backgroundColor="magenta" color="black" bold>
          {" rejected during mount "}
        </Text>
        <Text dimColor>{`  ${view.rejections.length}`}</Text>
      </Box>
      {view.rejections.map((rejection) => (
        <Box key={`${rejection.componentType}@${rejection.instanceId}-${rejection.reason}`}>
          <Text color="magenta">{"  ! "}</Text>
          <Text bold>{`${rejection.componentType} (${rejection.instanceId})`}</Text>
          <Text dimColor>
            {rejection.reason === "duplicate"
              ? "  duplicate — an earlier registration holds this key"
              : "  guard — onRegister rejected this registration"}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function Empty({ view }: { view: SurfaceView }): ReactElement {
  if (view.counts.hidden > 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor wrap="wrap">
          {`Nothing is callable here — all ${view.counts.hidden} registered capabilities were hidden by policy. `}
          The surface is empty by decision, not because nothing was annotated.
        </Text>
        {view.explained ? null : (
          <Text dimColor>Re-run with --explain to see which policy hid them.</Text>
        )}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="wrap">
        Nothing is registered for this scenario — the agent has no surface here. That is the
        default: capabilities exist only where they were explicitly annotated.
      </Text>
      {view.explained ? null : (
        <Text dimColor>Re-run with --explain to see whether a policy hid it.</Text>
      )}
    </Box>
  );
}

type Block = { key: string; group?: CapabilityGroup };

export function Surface({ view }: { view: SurfaceView }): ReactElement {
  const populated = view.groups.filter((group) => group.rows.length > 0);

  // Everything goes through <Static>, header included. Ink paints static output
  // once, permanently, above the live frame — and erases the live frame on
  // unmount. A one-shot render that leaves anything outside <Static> therefore
  // prints it and then wipes it, which is exactly what happened to this header.
  const blocks: Block[] = [
    { key: "__header" },
    ...populated.map((group) => ({ key: group.heading, group })),
  ];

  return (
    <Static items={blocks}>
      {(block) =>
        block.group ? (
          <Group key={block.key} group={block.group} />
        ) : (
          <Box key={block.key} flexDirection="column">
            <Header view={view} />
            {view.rejections.length > 0 ? <Rejections view={view} /> : null}
            {populated.length === 0 ? <Empty view={view} /> : null}
          </Box>
        )
      }
    </Static>
  );
}

export function Drift({
  scenario,
  entries,
}: {
  scenario: string;
  entries: DiffEntry[];
}): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text backgroundColor="yellow" color="black" bold>{` ${scenario} `}</Text>
        <Text dimColor>{`  ${entries.length} change${entries.length === 1 ? "" : "s"}`}</Text>
      </Box>
      {entries.map((entry) => (
        <Box key={`${entry.kind}-${entry.path}`} flexDirection="column" paddingLeft={2}>
          {entry.subject ? (
            <Text bold>
              {entry.subject}
              <Text dimColor>{`  ${entry.path}`}</Text>
            </Text>
          ) : null}
          {entry.kind === "added" ? (
            <Text color="green" wrap="wrap">{`+ ${entry.path}  ${formatValue(entry.after)}`}</Text>
          ) : entry.kind === "removed" ? (
            <Text color="red" wrap="wrap">{`- ${entry.path}  ${formatValue(entry.before)}`}</Text>
          ) : (
            <>
              <Text color="yellow">{`~ ${entry.path}`}</Text>
              <Text color="red" wrap="wrap">{`    before: ${formatValue(entry.before)}`}</Text>
              <Text color="green" wrap="wrap">{`    after:  ${formatValue(entry.after)}`}</Text>
            </>
          )}
        </Box>
      ))}
    </Box>
  );
}
