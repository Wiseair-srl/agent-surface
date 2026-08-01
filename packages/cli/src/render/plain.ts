import type { CapabilityRow, SurfaceView } from "./model.js";
import { flatRows } from "./model.js";
import {
  coverageSections,
  neverCallable,
  neverCallableSection,
  riskClause,
  runContextRows,
  runHeaderBlocks,
  scenarioTable,
  surfaceSummaryRows,
  unreadSection,
  type FindingSection,
  type ReportBlock,
  type ReportRow,
  type RunContext,
  type ScenarioStats,
  type SurfaceSummaryInput,
} from "./summary.js";
import type { DiffEntry } from "../baseline.js";
import { formatValue } from "../baseline.js";
import type { ScenarioFailure } from "../analysis.js";
import { unresolved, type CapabilityInventory } from "../extract.js";
import { unreadKey, type CoverageReport } from "../coverage.js";

/**
 * The no-colour, no-cursor rendering used when stdout is piped or when
 * `--plain`, `CI` or `NO_COLOR` is set. Same view model as the Ink UI, so the
 * two cannot disagree about what the surface contains.
 */

const MARK = { expose: "+", disable: "~", hide: "-" } as const;
const STATE = { expose: "callable", disable: "disabled", hide: "hidden" } as const;
const NONE = "—";
const REPORT_WIDTH = 100;

/**
 * Where a report's text column starts. Fixed rather than derived, so the
 * `Coverage`/`Baselines` matrix in `check` and the `Config`/`Depth` header
 * above it line up as one grid — a block that indents itself differently reads
 * as a different kind of thing.
 */
const LABEL_WIDTH = 12;
const STATUS_WIDTH = 7;

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
function renderTable(headers: string[], rows: Array<{ cells: string[]; note?: string }>): string[] {
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

/** The same grid, for a caller that owns its own heading. */
export function renderTablePlain(
  headers: string[],
  rows: Array<{ cells: string[]; note?: string }>,
): string {
  return renderTable(headers, rows).join("\n");
}

/** `UNREACHED — authored, and no scenario mounts it  (1)` */
function section(title: string, gloss: string, count: number): string {
  return `${title} — ${gloss}  (${count})`;
}

/**
 * A labelled block: an optional title, then `label  STATUS  text` rows.
 *
 * The label column is wide enough for the longest label in the report, never
 * narrower than `LABEL_WIDTH`, so every block in one report shares a grid.
 */
export function renderReportPlain(blocks: ReportBlock[]): string {
  const width = Math.max(
    LABEL_WIDTH,
    ...blocks.flatMap((block) => block.rows.map((row) => row.label.length + 2)),
  );
  const statuses = blocks.some((block) => block.rows.some((row) => row.status));
  const renderRow = (row: ReportRow): string =>
    `${row.label.padEnd(width)}${
      statuses ? (row.status ?? "").padEnd(STATUS_WIDTH) : ""
    }${row.text}`.trimEnd();

  return blocks
    .filter((block) => block.title || block.rows.length > 0)
    .map((block) => [...(block.title ? [block.title] : []), ...block.rows.map(renderRow)].join("\n"))
    .join("\n\n");
}

/** Findings, in the order they were built. Tables unindented, lists indented. */
export function renderSectionsPlain(sections: FindingSection[]): string {
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
export function renderCountsPlain(view: SurfaceView): string {
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
 * The run header: the command, what it was pointed at, and what every number
 * below is relative to. Printed before anything is mounted, because a reader
 * watching a slow mount should already know what is being measured.
 */
export function renderRunHeaderPlain(
  title: string,
  context: RunContext,
  inventory?: CapabilityInventory,
  domainCapabilities?: number,
): string {
  return renderReportPlain(runHeaderBlocks(title, context, inventory, domainCapabilities));
}

function componentOf(capabilityId: string): string {
  const path = capabilityId.replace(/^(view|domain):/, "");
  const dot = path.lastIndexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

export interface CatalogDetailOptions {
  /** Show the raw call-site table, origins, notes and diagnostic prose. */
  detail?: boolean;
}

/**
 * The catalog *below* its summary: which component authors what, and every call
 * site the extractor could not read.
 *
 * Only `--depth static` prints this. At `--depth full` the scenario tables name
 * every capability a scenario reached, the `UNREACHED` section names the ones it
 * did not, and the verdict carries the unread call sites — so printing it here
 * would be the same information a second time, above the answer instead of in it.
 */
export function renderCatalogDetailPlain(
  inventory: CapabilityInventory,
  options: CatalogDetailOptions = {},
): string {
  const lines: string[] = [];
  const resolved = inventory.capabilities.filter((c) => c.resolution !== "unresolved");
  const unreadEntries = unresolved(inventory);

  const components = new Map<string, { ids: Set<string>; sites: number; partial: number }>();
  for (const capability of resolved) {
    const component = componentOf(capability.capabilityId);
    const current = components.get(component) ?? { ids: new Set<string>(), sites: 0, partial: 0 };
    current.ids.add(capability.capabilityId);
    current.sites += 1;
    if (capability.resolution === "partial") current.partial += 1;
    components.set(component, current);
  }

  if (components.size > 0) {
    lines.push(`COMPONENTS  (${components.size})`);
    lines.push(
      ...renderTable(
        ["COMPONENT", "CAPABILITIES", "CALL SITES", "DYNAMIC META"],
        [...components.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([component, data]) => ({
            cells: [
              `view:${component}`,
              String(data.ids.size),
              String(data.sites),
              data.partial > 0 ? String(data.partial) : NONE,
            ],
            note: [...data.ids].sort().join(" · "),
          })),
      ),
    );
  }

  if (unreadEntries.length > 0) {
    const groups = new Map<string, number>();
    for (const entry of unreadEntries) {
      const key = `${entry.origin.file}\0${entry.reason ?? "unknown"}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    if (lines.length > 0) lines.push("");
    lines.push(`UNREAD SITES  (${unreadEntries.length})`);
    lines.push("Counts above are a floor until these sites are resolved or explicitly accepted.");
    lines.push(
      ...renderTable(
        ["FILE", "REASON", "SITES"],
        [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, count]) => {
            const [file, reason] = key.split("\0");
            return { cells: [file ?? "?", reason ?? "unknown", String(count)] };
          }),
      ),
    );
    lines.push("", "ALLOWLIST KEYS");
    for (const entry of unreadEntries) lines.push(`  allowlist key: ${unreadKey(entry)}`);
  }

  if (options.detail) {
    const byId = [...resolved].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    if (byId.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`CAPABILITY DETAILS  (${byId.length} call sites)`);
      lines.push(
        ...renderTable(
          ["CAPABILITY", "KIND", "ORIGIN", "READ"],
          byId.map((capability) => ({
            cells: [
              capability.capabilityId,
              capability.kind,
              `${capability.origin.file}:${capability.origin.line}`,
              capability.resolution,
            ],
            ...(capability.note ? { note: capability.note } : {}),
          })),
        ),
      );
    }
    if (unreadEntries.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(renderSectionsPlain([unreadSection(unreadEntries)]));
    }
  } else if (unreadEntries.length > 0 || resolved.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "Details: re-run with --detail for origins, metadata diagnostics, and allowlist keys.",
    );
  }
  return lines.join("\n");
}

export interface CoverageRenderOptions {
  /** Check already prints an executive summary; render findings only. */
  compact?: boolean;
  /** Include non-gating inventories such as undeclared runtime ids. */
  detail?: boolean;
}

/**
 * The verdict: authored minus reached (`AS-COVER-004…005`).
 *
 * This is the finding the command surface used to hide behind a fifth command,
 * so it is the last thing printed and the thing a reader stops on.
 */
export function renderCoveragePlain(
  report: CoverageReport,
  options: CoverageRenderOptions = {},
): string {
  const sections = coverageSections(report, options);
  return sections.length > 0 ? renderSectionsPlain(sections) : "";
}

/** The closing block, and the findings that belong with it. */
export function renderSurfaceSummaryPlain(input: SurfaceSummaryInput): string {
  const dark = neverCallable(input.reach);
  // Over one scenario, "never callable" repeats that scenario's own table row
  // for row — see neverCallableSection().
  const mounted = input.scenarios.filter((entry) => !entry.failed).length;
  const sections = [
    ...(input.coverage ? coverageSections(input.coverage) : []),
    ...(dark.length > 0 && mounted > 1 ? [neverCallableSection(dark)] : []),
  ];
  const summary = renderReportPlain([{ title: "SURFACE SUMMARY", rows: surfaceSummaryRows(input) }]);
  return sections.length > 0 ? `${renderSectionsPlain(sections)}\n\n${summary}` : summary;
}

export interface CheckOverview {
  status: "PASS" | "FAIL" | "ERROR";
  coverage?: CoverageReport;
  unresolvedAllowed: boolean;
  baselineCurrent: number;
  baselineTotal: number;
  scenarioManifestOk: boolean;
  rejected: number;
  mountFailures: number;
  scenarios: string[];
  /** What the run was pointed at. Printed above the matrix (`AS-CLI-007`). */
  context?: RunContext;
  /** Per-scenario totals. Replaces the bare name list when available. */
  stats?: ScenarioStats[];
}

function wrappedList(items: string[]): string[] {
  const prefix = "  ";
  return wrapText(items.join(", "), REPORT_WIDTH - prefix.length).map((line) => `${prefix}${line}`);
}

/** The health matrix: one row per class of finding, whether or not it fired. */
function checkMatrixRows(input: CheckOverview): ReportRow[] {
  const rows: ReportRow[] = [];
  const coverage = input.coverage;

  if (coverage) {
    rows.push({
      label: "Coverage",
      status:
        coverage.unreached.length > 0 || coverage.staleAllowlist.length > 0
          ? "FAIL"
          : coverage.allowed.length > 0
            ? "WARN"
            : "PASS",
      text:
        `${coverage.reached}/${coverage.authored} authored capabilities reached` +
        (coverage.unreached.length > 0 ? ` · ${coverage.unreached.length} unreached` : "") +
        (coverage.allowed.length > 0 ? ` · ${coverage.allowed.length} unreached allowlisted` : "") +
        (coverage.staleAllowlist.length > 0
          ? ` · ${coverage.staleAllowlist.length} stale allowlist entr${
              coverage.staleAllowlist.length === 1 ? "y" : "ies"
            }`
          : ""),
    });

    const unread = coverage.unresolved.length;
    const accepted = coverage.allowedUnread.length;
    rows.push({
      label: "Catalog",
      status:
        coverage.staleUnreadAllowlist.length > 0 || (unread > 0 && !input.unresolvedAllowed)
          ? "FAIL"
          : unread > 0 || accepted > 0
            ? "WARN"
            : "PASS",
      text:
        coverage.staleUnreadAllowlist.length > 0
          ? `${coverage.staleUnreadAllowlist.length} stale unread allowlist entr${
              coverage.staleUnreadAllowlist.length === 1 ? "y" : "ies"
            }`
          : unread > 0
            ? `${unread} unread static site${unread === 1 ? "" : "s"}${
                input.unresolvedAllowed ? " accepted by --allow-unresolved" : ""
              }`
            : accepted > 0
              ? `${accepted} unread static site${accepted === 1 ? "" : "s"} allowlisted`
              : "all static sites resolved",
    });

    rows.push({
      label: "Domain",
      status:
        coverage.unmanifestedDomain.length > 0
          ? "FAIL"
          : coverage.domainAuthoritative
            ? "PASS"
            : "WARN",
      text:
        coverage.unmanifestedDomain.length > 0
          ? `${coverage.unmanifestedDomain.length} mounted capabilit${
              coverage.unmanifestedDomain.length === 1 ? "y" : "ies"
            } absent from manifest`
          : coverage.domainAuthoritative
            ? `${coverage.domainReached.length} manifest capabilit${
                coverage.domainReached.length === 1 ? "y" : "ies"
              } reached`
            : "authoritative manifest not configured",
    });
  } else {
    rows.push({
      label: "Coverage",
      status: input.status === "ERROR" ? "ERROR" : "WARN",
      text:
        input.status === "ERROR"
          ? "no verdict; runtime analysis incomplete"
          : "not evaluated — statement about these scenarios only; re-run with --depth full",
    });
  }

  const baselineOk = input.baselineCurrent === input.baselineTotal && input.scenarioManifestOk;
  rows.push({
    label: "Baselines",
    status: baselineOk ? "PASS" : "FAIL",
    text:
      `${input.baselineCurrent}/${input.baselineTotal} scenario baselines current` +
      (input.scenarioManifestOk ? "" : " · scenario manifest differs"),
  });

  rows.push({
    label: "Runtime",
    status: input.mountFailures > 0 ? "ERROR" : input.rejected > 0 ? "FAIL" : "PASS",
    text:
      input.mountFailures > 0
        ? `${input.mountFailures} scenario${input.mountFailures === 1 ? "" : "s"} did not mount`
        : input.rejected > 0
          ? `${input.rejected} registration${input.rejected === 1 ? "" : "s"} rejected`
          : `${input.scenarios.length} scenario${input.scenarios.length === 1 ? "" : "s"} mounted`,
  });

  return rows;
}

/** First-screen answer for `check`: verdict, context, health, then scenarios. */
export function renderCheckOverviewPlain(input: CheckOverview): string {
  const blocks: ReportBlock[] = [
    {
      title: `SURFACE CHECK  ${input.status}`,
      rows: input.context ? runContextRows(input.context) : [],
    },
    { rows: checkMatrixRows(input) },
  ];

  const table = input.stats ? scenarioTable(input.stats, { baselines: true }) : undefined;
  const scenarios =
    input.stats && table
      ? [`SCENARIOS  (${input.stats.length})`, ...renderTable(table.headers, table.rows)]
      : [`SCENARIOS  (${input.scenarios.length})`, ...wrappedList(input.scenarios)];

  return `${renderReportPlain(blocks)}\n\n${scenarios.join("\n")}`;
}

/** The commands that clear this report, in the order worth running them. */
export function renderNextStepsPlain(steps: string[]): string {
  return [
    "NEXT STEPS",
    ...steps.flatMap((step, index) =>
      wrapText(step, REPORT_WIDTH - 5).map(
        (line, wrapped) => `  ${wrapped === 0 ? `${index + 1}.` : "  "} ${line}`,
      ),
    ),
  ].join("\n");
}

/**
 * Why there is no coverage verdict. Never silence: a reader who asked for the
 * complete answer and got a partial one has to be told which part is missing,
 * or the partial one reads as the complete one.
 */
export function renderNoVerdictPlain(failures: ScenarioFailure[]): string {
  // The failures themselves are listed directly above, by DID NOT MOUNT. This
  // says what their absence costs the rest of the report, and nothing else.
  return [
    section(
      "NO COVERAGE VERDICT",
      "a scenario did not mount, so nothing reached anything",
      failures.length,
    ),
    "  Every capability those scenarios would have surfaced would be reported unreached,",
    "  so no verdict is printed at all. Fix the mount, or name a scenario that works.",
  ].join("\n");
}

export function renderFailuresPlain(failures: ScenarioFailure[]): string {
  return [
    section("DID NOT MOUNT", "these scenarios threw, and were skipped", failures.length),
    ...failures.flatMap((failure) => [`  ${failure.scenario}`, `      ${failure.message}`]),
  ].join("\n");
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
