import type { CapabilityRow, SurfaceView } from "./model.js";
import { flatRows } from "./model.js";
import {
  checkOverviewParts,
  reportGrid,
  riskClause,
  STATUS_WIDTH,
  type CheckOverview,
  type FindingSection,
  type ReportBlock,
  type ReportPart,
  type ReportRow,
  type TableRow,
} from "./summary.js";
import type { DiffEntry } from "../baseline.js";
import { formatValue } from "../baseline.js";

/**
 * The no-colour, no-cursor rendering used when a stream is piped or when
 * `--plain`, `CI` or `NO_COLOR` is set. Same report parts as the Ink UI, so the
 * two cannot disagree about what the surface contains — or about where a block
 * begins.
 */

const MARK = { expose: "+", disable: "~", hide: "-" } as const;
const STATE = { expose: "callable", disable: "disabled", hide: "hidden" } as const;
const NONE = "—";
const REPORT_WIDTH = 100;

/** Deterministic wrapping: readable in logs, independent of terminal width. */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Column widths come from the *content*, never from `process.stdout.columns`.
 *
 * `AS-CLI-003` requires plain output to be byte-stable across runs, and a table
 * laid out against the terminal it happened to run in is stable only until two
 * people diff the same CI log from different windows. Same rows in, same bytes
 * out, everywhere.
 *
 * The last column is not padded, so no line ever carries trailing whitespace —
 * which some diff tools render and others strip, i.e. another way for identical
 * output to look different.
 */
function renderTable(headers: string[], rows: TableRow[]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row.cells[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === headers.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd();

  const lines = [line(headers)];
  for (const row of rows) {
    lines.push(line(row.cells));
    // The unavailability reason is prose of unbounded length. A column for it
    // would set the table's width by its longest sentence; a continuation line
    // keeps the grid aligned and puts the reason directly under its capability.
    if (row.note) {
      for (const [index, note] of wrapText(row.note, REPORT_WIDTH - 6).entries()) {
        lines.push(`    ${index === 0 ? "⤷ " : "  "}${note}`);
      }
    }
  }
  return lines;
}

/** `UNREACHED — authored, and no scenario mounts it  (1)` */
function section(title: string, gloss: string, count: number): string {
  return `${title} — ${gloss}  (${count})`;
}

/**
 * A labelled block: an optional title, then `label  STATUS  text` rows.
 *
 * The label column is the report's, not this block's (`reportGrid`) — every
 * block in one report shares one text column, whichever renderer drew it.
 */
export function renderReportPlain(blocks: ReportBlock[], labelWidth?: number): string {
  const grid = reportGrid(blocks, labelWidth);
  const renderRow = (row: ReportRow): string =>
    `${row.label.padEnd(grid.label)}${
      grid.statuses ? (row.status ?? "").padEnd(STATUS_WIDTH) : ""
    }${row.text}`.trimEnd();

  return blocks
    .filter((block) => block.title || block.rows.length > 0)
    .map((block) => [...(block.title ? [block.title] : []), ...block.rows.map(renderRow)].join("\n"))
    .join("\n\n");
}

/** Findings, in the order they were built. Tables unindented, lists indented. */
function renderSectionsPlain(sections: FindingSection[]): string {
  return sections
    .map((entry) => {
      const lines = [
        entry.count > 0
          ? section(entry.title, entry.gloss, entry.count)
          : `${entry.title} — ${entry.gloss}`,
      ];
      if (entry.headers && entry.rows) lines.push(...renderTable(entry.headers, entry.rows));
      if (entry.lines) lines.push(...entry.lines.map((line) => `  ${line}`.trimEnd()));
      if (entry.hint) {
        lines.push(
          ...wrapText(entry.hint, REPORT_WIDTH - 4).map(
            (line, index) => `  ${index === 0 ? "→" : " "} ${line}`,
          ),
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** The commands that clear this report, in the order worth running them. */
function renderStepsPlain(title: string, steps: string[]): string {
  return [
    title,
    ...steps.flatMap((step, index) =>
      wrapText(step, REPORT_WIDTH - 5).map(
        (line, wrapped) => `  ${wrapped === 0 ? `${index + 1}.` : "  "} ${line}`,
      ),
    ),
  ].join("\n");
}

/**
 * One part of a report. Every command's output is a list of these, so a block
 * cannot be laid out one way in `inspect` and another in `check`.
 */
export function renderPartPlain(part: ReportPart, labelWidth?: number): string {
  switch (part.kind) {
    case "blocks":
      return renderReportPlain(part.blocks, labelWidth);
    case "table":
      return [
        part.title,
        ...(part.lead ? [part.lead] : []),
        ...renderTable(part.headers, part.rows),
      ].join("\n");
    case "findings":
      return renderSectionsPlain(part.sections);
    case "surface":
      return renderSurfacePlain(part.view, { ...(part.detail ? { detail: true } : {}) });
    case "note":
      return [...(part.title ? [part.title] : []), ...part.lines].join("\n");
    case "steps":
      return renderStepsPlain(part.title, part.steps);
  }
}

/** A whole report, one blank line between parts. */
export function renderPartsPlain(parts: ReportPart[], labelWidth?: number): string {
  return parts
    .map((part) => renderPartPlain(part, labelWidth))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function renderDetailRow(row: CapabilityRow, lines: string[]): void {
  const tags = row.tags.length > 0 ? `  [${row.tags.join(", ")}]` : "";
  lines.push(`  ${MARK[row.outcome]} ${row.name}${tags}`);
  lines.push(`      ${row.description}`);
  if (row.reason) lines.push(`      reason: ${row.reason}`);

  if (row.policies) {
    if (row.policies.length === 0) {
      lines.push("      policies: none");
    } else {
      for (const policy of row.policies) {
        const vote = policy.discovery
          ? policy.discovery.decision === "disable"
            ? `disable — ${policy.discovery.reason}`
            : policy.discovery.decision
          : "no discovery hook";
        const phases = policy.phases.length > 0 ? policy.phases.join("/") : NONE;
        const flags = [
          policy.threw ? "THREW" : "",
          policy.confirmationEscalation ? "escalates-confirmation" : "",
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `      policy ${policy.name} (${policy.scope}, ${phases}): ${vote}${
            flags ? ` [${flags}]` : ""
          }`,
        );
      }
    }
    if (row.availability && !row.availability.available) {
      lines.push(
        `      availability: unavailable${
          row.availability.reason ? ` — ${row.availability.reason}` : ""
        }`,
      );
    }
  }

  if (row.schemas) {
    if (row.schemas.input !== undefined) {
      lines.push(`      input: ${JSON.stringify(row.schemas.input)}`);
    }
    if (row.schemas.output !== undefined) {
      lines.push(`      output: ${JSON.stringify(row.schemas.output)}`);
    }
  }
}

/**
 * The counts line, and everything it is relative to (`AS-CLI-007`).
 *
 * `hidden` is printed unconditionally. It is computed on every run — the
 * explanation is always collected — and suppressing it outside `--explain`
 * meant a surface with a policy-hidden half rendered as a complete one. The
 * *attribution* still needs `--explain`; the count and the rows do not.
 *
 * The risk clause is the same argument one level up: `9 callable` says how much
 * surface there is and nothing about what it can do, and "one of these deletes
 * a device" is the part a reader needs before they read anything else.
 */
function renderCountsPlain(view: SurfaceView): string {
  const risk = riskClause(flatRows(view));
  return (
    `${view.counts.callable} callable, ${view.counts.disabled} visible-disabled, ` +
    `${view.counts.hidden} hidden` +
    (view.rejections.length > 0
      ? `, ${view.rejections.length} registration${view.rejections.length === 1 ? "" : "s"} rejected`
      : "") +
    (risk ? `  ·  ${risk}` : "")
  );
}

function renderHeader(view: SurfaceView, lines: string[]): void {
  lines.push(
    `scenario ${view.scenario}${view.route ? `  route ${view.route}` : ""}${
      view.scope && view.scope.length > 0 ? `  scope ${view.scope.join(" ")}` : ""
    }`,
  );
  lines.push(renderCountsPlain(view));
}

function renderRejections(view: SurfaceView, lines: string[]): void {
  if (view.rejections.length === 0) return;
  lines.push("");
  lines.push(
    section("REJECTED", "the registry refused these during the mount", view.rejections.length),
  );
  for (const rejection of view.rejections) {
    const why =
      rejection.reason === "duplicate"
        ? "duplicate — an earlier registration holds this key"
        : "guard — onRegister rejected this registration";
    lines.push(`  ! ${rejection.componentType} (${rejection.instanceId})  ${why}`);
  }
}

function renderEmpty(view: SurfaceView, lines: string[]): void {
  lines.push("");
  // "Nothing is registered" is only true when nothing was hidden. Saying it
  // over a surface a policy emptied sends the reader to the wrong file.
  if (view.counts.hidden > 0) {
    lines.push(
      `Nothing is callable here — all ${view.counts.hidden} registered capabilities were hidden by policy.`,
    );
    if (!view.explained) lines.push("Re-run with --explain to see which policy hid them.");
  } else {
    lines.push("Nothing is registered for this scenario — the agent has no surface here.");
    if (!view.explained) lines.push("Re-run with --explain to see whether a policy hid it.");
  }
}

export interface SurfaceRenderOptions {
  /** The grouped, one-capability-per-paragraph view. Implied by --explain/--schemas. */
  detail?: boolean;
}

/**
 * One capability per line, aligned. The default, because the question `inspect`
 * is usually asked is *what is on this surface* — which is a scanning question,
 * and prose does not scan.
 *
 * Policy chains and JSON Schemas are multi-line by nature and cannot live in a
 * cell, so `--explain` and `--schemas` fall back to the detail view rather than
 * producing a table with most of the answer missing.
 */
export function renderSurfacePlain(view: SurfaceView, options: SurfaceRenderOptions = {}): string {
  const lines: string[] = [];
  renderHeader(view, lines);
  renderRejections(view, lines);

  const rows = flatRows(view);
  if (rows.length === 0) {
    renderEmpty(view, lines);
    return lines.join("\n");
  }

  if (options.detail) {
    for (const group of view.groups.filter((group) => group.rows.length > 0)) {
      lines.push("");
      lines.push(`${group.heading}  (${group.rows.length})`);
      for (const row of group.rows) renderDetailRow(row, lines);
    }
    return lines.join("\n");
  }

  lines.push("");
  lines.push(
    ...renderTable(
      ["CAPABILITY", "KIND", "EFFECT", "STATE", "FLAGS"],
      rows.map((row) => ({
        cells: [
          row.path,
          row.kind,
          row.effect ?? NONE,
          STATE[row.outcome],
          row.flags.length > 0 ? row.flags.join(" · ") : NONE,
        ],
        ...(row.reason ? { note: row.reason } : {}),
      })),
    ),
  );
  return lines.join("\n");
}

/**
 * First-screen answer for `check`: verdict, context, health, then scenarios.
 *
 * Exported for the unit test that drives the matrix through every combination
 * a real run would take minutes to reach. The command itself emits the parts.
 */
export function renderCheckOverviewPlain(input: CheckOverview): string {
  return renderPartsPlain(checkOverviewParts(input));
}

/** One scenario's drift, unindented — the section renderer owns the indent. */
export function renderDriftPlain(scenario: string, entries: DiffEntry[]): string[] {
  const lines = [`${scenario}: ${entries.length} change${entries.length === 1 ? "" : "s"}`];
  for (const entry of entries) {
    const where = entry.subject ? `${entry.subject}  (${entry.path})` : entry.path;
    if (entry.kind === "added") lines.push(`  + ${where}  ${formatValue(entry.after)}`);
    else if (entry.kind === "removed") lines.push(`  - ${where}  ${formatValue(entry.before)}`);
    else {
      lines.push(`  ~ ${where}`);
      lines.push(`      before: ${formatValue(entry.before)}`);
      lines.push(`      after:  ${formatValue(entry.after)}`);
    }
  }
  return lines;
}
