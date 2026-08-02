import type { ReactElement } from "react";
import { Box, Static, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import type { CapabilityRow, CapabilityGroup, SurfaceView } from "./model.js";
import { flatRows } from "./model.js";
import {
  reportGrid,
  riskClause,
  STATUS_WIDTH,
  type FindingSection,
  type ReportBlock,
  type ReportPart,
  type ReportRow,
  type TableRow,
} from "./summary.js";

const OUTCOME = {
  expose: { mark: "●", color: "green" as const, state: "callable" },
  disable: { mark: "◐", color: "yellow" as const, state: "disabled" },
  hide: { mark: "○", color: "red" as const, state: "hidden" },
};

const STATUS_COLOR = {
  PASS: "green",
  WARN: "yellow",
  FAIL: "red",
  ERROR: "red",
} as const;

const TONE_COLOR = { good: "green", warn: "yellow", bad: "red" } as const;

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
      <Text dimColor>{` ${label}…`}</Text>
    </Text>
  );
}

/** One `label  STATUS  text` row, coloured by whichever of the two it carries. */
function Row({ row, width, statuses }: { row: ReportRow; width: number; statuses: boolean }): ReactElement {
  return (
    <Box>
      <Text dimColor>{pad(row.label, width)}</Text>
      {statuses ? (
        <Text bold color={row.status ? STATUS_COLOR[row.status] : undefined}>
          {pad(row.status ?? "", STATUS_WIDTH)}
        </Text>
      ) : null}
      <Text color={row.tone ? TONE_COLOR[row.tone] : undefined} wrap="wrap">
        {row.text}
      </Text>
    </Box>
  );
}

/**
 * The labelled blocks a report is built from — the run header, the catalog
 * summary, the closing verdict. Same rows the plain renderer prints, same
 * widths from the same `reportGrid`, with the status word and the tone carrying
 * colour on a terminal.
 */
export function Report({
  blocks,
  labelWidth,
}: {
  blocks: ReportBlock[];
  labelWidth?: number;
}): ReactElement {
  const grid = reportGrid(blocks, labelWidth);
  // An empty, untitled block is dropped rather than painted, exactly as the
  // plain renderer drops it — otherwise the same report carries a blank line in
  // the terminal that a CI log does not have.
  const drawn = blocks.filter((block) => block.title || block.rows.length > 0);
  // Ink prints a newline of its own after each painted frame, so only the
  // blocks *within* one frame ask for the blank line above them. A margin on
  // the first would double it, which reads as a missing block rather than as
  // breathing room.
  return (
    <Static
      items={drawn.map((block, index) => ({ key: block.title ?? `block-${index}`, block, index }))}
    >
      {({ key, block, index }) => (
        <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          {block.title ? <Text bold>{block.title}</Text> : null}
          {block.rows.map((row) => (
            <Row key={row.label} row={row} width={grid.label} statuses={grid.statuses} />
          ))}
        </Box>
      )}
    </Static>
  );
}

function Grid({ headers, rows }: { headers: string[]; rows: TableRow[] }): ReactElement {
  const widths = widthsFor(
    headers,
    rows.map((row) => row.cells),
  );
  return (
    <Box flexDirection="column">
      <Box>
        {headers.map((header, column) => (
          <Text key={header} dimColor bold>
            {column === headers.length - 1 ? header : `${pad(header, widths[column]!)}  `}
          </Text>
        ))}
      </Box>
      {rows.map((row, index) => (
        <Box key={`${row.cells[0]}-${index}`} flexDirection="column">
          <Box>
            {row.cells.map((cell, column) => (
              <Text key={`${column}`} bold={column === 0}>
                {column === headers.length - 1 ? cell : `${pad(cell, widths[column]!)}  `}
              </Text>
            ))}
          </Box>
          {row.note ? (
            <Box paddingLeft={4}>
              <Text dimColor wrap="wrap">{`⤷ ${row.note}`}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function Table({
  title,
  lead,
  headers,
  rows,
}: {
  title: string;
  lead?: string;
  headers: string[];
  rows: TableRow[];
}): ReactElement {
  return (
    <Static items={[{ key: title }]}>
      {(block) => (
        <Box key={block.key} flexDirection="column">
          <Text bold>{title}</Text>
          {lead ? (
            <Text dimColor wrap="wrap">
              {lead}
            </Text>
          ) : null}
          <Grid headers={headers} rows={rows} />
        </Box>
      )}
    </Static>
  );
}

/**
 * Lines that are neither a grid nor a finding: a closing hint, a list of keys
 * to copy. Never wrapped, and dimmed only where the part says so — an allowlist
 * key is read by selecting it, and a reflowed or greyed-out one is a key nobody
 * pastes.
 */
export function Note({
  title,
  lines,
  muted,
}: {
  title?: string;
  lines: string[];
  muted?: boolean;
}): ReactElement {
  return (
    <Static items={[{ key: title ?? lines[0] ?? "note" }]}>
      {(block) => (
        <Box key={block.key} flexDirection="column">
          {title ? <Text bold>{title}</Text> : null}
          {lines.map((line, index) => (
            <Text key={`${index}`} dimColor={muted === true}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Static>
  );
}

/** The commands that clear a report, in the order worth running them. */
export function Steps({ title, steps }: { title: string; steps: string[] }): ReactElement {
  return (
    <Static items={[{ key: title }]}>
      {(block) => (
        <Box key={block.key} flexDirection="column">
          <Text bold>{title}</Text>
          {steps.map((step, index) => (
            <Box key={`${index}`} paddingLeft={2}>
              <Text color="cyan">{`${index + 1}. `}</Text>
              <Text wrap="wrap">{step}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Static>
  );
}

/**
 * Findings. The heading says what it is, the gloss why it matters, and the hint
 * what to do — printed with the finding rather than left to be inferred.
 */
export function Findings({ sections }: { sections: FindingSection[] }): ReactElement {
  return (
    <Static
      items={sections.map((section, index) => ({ key: `${section.title}-${index}`, section, index }))}
    >
      {({ key, section, index }) => (
        <Box key={key} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          <Box>
            <Text
              backgroundColor={section.tone === "notice" ? "yellow" : "red"}
              color="black"
              bold
            >{` ${section.title} `}</Text>
            <Text dimColor>{`  ${section.gloss}${section.count > 0 ? `  ${section.count}` : ""}`}</Text>
          </Box>
          {section.headers && section.rows ? (
            <Grid headers={section.headers} rows={section.rows} />
          ) : null}
          {(section.lines ?? []).map((line, index) => (
            <Box key={`${index}`} paddingLeft={2}>
              <Text>{line}</Text>
            </Box>
          ))}
          {section.hint ? (
            <Box paddingLeft={2}>
              <Text color="cyan" wrap="wrap">{`→ ${section.hint}`}</Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Static>
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
  // What the surface can do, not just how much of it there is: "one of these
  // deletes a device" is the part a reader needs before they read anything else.
  const risk = riskClause(flatRows(view));
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
      {risk ? (
        <>
          <Text dimColor>{"  ·  "}</Text>
          <Text color="magenta">{risk}</Text>
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

/**
 * One part of a report, drawn.
 *
 * This switch is the only place the terminal UI learns what a report can
 * contain, and it is the same list `renderPartPlain` switches on — so a part
 * that renders here renders there, and neither can grow a shape the other has
 * never heard of.
 */
export function Part({
  part,
  labelWidth,
}: {
  part: ReportPart;
  labelWidth?: number;
}): ReactElement {
  switch (part.kind) {
    case "blocks":
      return <Report blocks={part.blocks} {...(labelWidth ? { labelWidth } : {})} />;
    case "table":
      return (
        <Table
          title={part.title}
          {...(part.lead ? { lead: part.lead } : {})}
          headers={part.headers}
          rows={part.rows}
        />
      );
    case "findings":
      return <Findings sections={part.sections} />;
    case "surface":
      return <Surface view={part.view} {...(part.detail ? { detail: true } : {})} />;
    case "note":
      return (
        <Note
          {...(part.title ? { title: part.title } : {})}
          {...(part.muted ? { muted: true } : {})}
          lines={part.lines}
        />
      );
    case "steps":
      return <Steps title={part.title} steps={part.steps} />;
  }
}

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

