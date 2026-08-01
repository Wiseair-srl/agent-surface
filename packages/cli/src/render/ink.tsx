import type { ReactElement } from "react";
import { Box, Static, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import type { CapabilityRow, CapabilityGroup, SurfaceView } from "./model.js";
import { flatRows } from "./model.js";
import type { CoverageReport } from "../coverage.js";

const OUTCOME = {
  expose: { mark: "●", color: "green" as const, state: "callable" },
  disable: { mark: "◐", color: "yellow" as const, state: "disabled" },
  hide: { mark: "○", color: "red" as const, state: "hidden" },
};

const NONE = "—";

/**
 * Same column widths as the plain renderer computes, and for the same reason:
 * from the content, never from the terminal. A TTY table that reflows on resize
 * and a piped table that does not would be two different renderings of one view
 * model, which is exactly what this file exists to prevent.
 */
function widthsFor(headers: string[], rows: string[][]): number[] {
  return headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

/**
 * `init`'s one question. Enter accepts, because the answer this asks for is the
 * one the summary above it has already made the case for — and because a
 * scaffold is the least destructive thing this package writes.
 */
export function Confirm({
  question,
  onAnswer,
}: {
  question: string;
  onAnswer: (yes: boolean) => void;
}): ReactElement {
  useInput((input, key) => {
    if (key.return || input.toLowerCase() === "y") onAnswer(true);
    else if (key.escape || input.toLowerCase() === "n" || (key.ctrl && input === "c")) {
      onAnswer(false);
    }
  });
  return (
    <Box marginTop={1}>
      <Text bold>{question}</Text>
      <Text dimColor>{"  (Y/n) "}</Text>
    </Box>
  );
}

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

const HEADERS = ["CAPABILITY", "KIND", "EFFECT", "STATE", "FLAGS"];

function cellsFor(row: CapabilityRow): string[] {
  return [
    row.path,
    row.kind,
    row.effect ?? NONE,
    OUTCOME[row.outcome].state,
    row.flags.length > 0 ? row.flags.join(" · ") : NONE,
  ];
}

function TableRow({
  row,
  cells,
  widths,
}: {
  row: CapabilityRow;
  cells: string[];
  widths: number[];
}): ReactElement {
  const outcome = OUTCOME[row.outcome];
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{`${pad(cells[0]!, widths[0]!)}  `}</Text>
        <Text dimColor>{`${pad(cells[1]!, widths[1]!)}  `}</Text>
        <Text>{`${pad(cells[2]!, widths[2]!)}  `}</Text>
        <Text color={outcome.color}>{`${pad(cells[3]!, widths[3]!)}  `}</Text>
        <Text dimColor>{cells[4]!}</Text>
      </Box>
      {row.reason ? (
        <Box paddingLeft={4}>
          <Text color="yellow" wrap="wrap">{`⤷ ${row.reason}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * One capability per line, aligned — the scanning view, and the default. The
 * grouped paragraphs below stay for `--detail`, `--explain` and `--schemas`,
 * whose payloads (policy chains, JSON Schemas) cannot live in a table cell.
 */
function CapabilityTable({ rows }: { rows: CapabilityRow[] }): ReactElement {
  const cells = rows.map(cellsFor);
  const widths = widthsFor(HEADERS, cells);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {HEADERS.map((header, column) => (
          <Text key={header} dimColor bold>
            {column === HEADERS.length - 1 ? header : `${pad(header, widths[column]!)}  `}
          </Text>
        ))}
      </Box>
      {rows.map((row, index) => (
        <TableRow
          key={`${row.capabilityId}-${index}`}
          row={row}
          cells={cells[index]!}
          widths={widths}
        />
      ))}
    </Box>
  );
}

type Block = { key: string; group?: CapabilityGroup; rows?: CapabilityRow[] };

export function Surface({
  view,
  detail,
}: {
  view: SurfaceView;
  detail?: boolean;
}): ReactElement {
  const populated = view.groups.filter((group) => group.rows.length > 0);
  const rows = flatRows(view);

  // Everything goes through <Static>, header included. Ink paints static output
  // once, permanently, above the live frame — and erases the live frame on
  // unmount. A one-shot render that leaves anything outside <Static> therefore
  // prints it and then wipes it, which is exactly what happened to this header.
  const blocks: Block[] = [
    { key: "__header" },
    ...(detail
      ? populated.map((group) => ({ key: group.heading, group }))
      : rows.length > 0
        ? [{ key: "__table", rows }]
        : []),
  ];

  return (
    <Static items={blocks}>
      {(block) =>
        block.group ? (
          <Group key={block.key} group={block.group} />
        ) : block.rows ? (
          <CapabilityTable key={block.key} rows={block.rows} />
        ) : (
          <Box key={block.key} flexDirection="column">
            <Header view={view} />
            {view.rejections.length > 0 ? <Rejections view={view} /> : null}
            {rows.length === 0 ? <Empty view={view} /> : null}
          </Box>
        )
      }
    </Static>
  );
}

/**
 * The verdict — authored minus reached. The finding the command surface used to
 * keep behind a fifth command, so it is the last thing painted and the thing a
 * reader stops on.
 */
export function Coverage({ report }: { report: CoverageReport }): ReactElement {
  const clean =
    report.unreached.length === 0 &&
    report.unresolved.length === 0 &&
    report.staleAllowlist.length === 0;

  return (
    <Static items={[{ key: "__coverage" }]}>
      {(block) => (
        <Box key={block.key} flexDirection="column" marginTop={1}>
          {report.unreached.length > 0 ? (
            <Box flexDirection="column">
              <Box>
                <Text backgroundColor="red" color="black" bold>
                  {" UNREACHED "}
                </Text>
                <Text dimColor>{`  authored, and no scenario mounts it  ${report.unreached.length}`}</Text>
              </Box>
              {report.unreached.map((entry) => (
                <Box key={entry.capabilityId} paddingLeft={2}>
                  <Text bold>{entry.capabilityId}</Text>
                  <Text dimColor>{`  ${entry.origin.file}:${entry.origin.line}`}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
          <Box marginTop={report.unreached.length > 0 ? 1 : 0}>
            <Text color={clean ? "green" : "red"} bold>
              {`${report.authored} authored · ${report.reached} reached · ${report.unreached.length} unreached`}
            </Text>
            <Text dimColor>{`  ${report.scenarios.join(", ")}`}</Text>
          </Box>
        </Box>
      )}
    </Static>
  );
}
