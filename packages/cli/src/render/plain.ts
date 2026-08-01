import { relative } from "node:path";
import type { CapabilityRow, SurfaceView } from "./model.js";
import { flatRows } from "./model.js";
import type { DiffEntry } from "../baseline.js";
import { formatValue } from "../baseline.js";
import type { ScenarioFailure } from "../analysis.js";
import {
  authoredIds,
  unresolved,
  type AuthoredCapability,
  type CapabilityInventory,
} from "../extract.js";
import { unreadKey, type CoverageReport } from "../coverage.js";

/**
 * The no-colour, no-cursor rendering used when stdout is piped or when
 * `--plain`, `CI` or `NO_COLOR` is set. Same view model as the Ink UI, so the
 * two cannot disagree about what the surface contains.
 */

const MARK = { expose: "+", disable: "~", hide: "-" } as const;
const STATE = { expose: "callable", disable: "disabled", hide: "hidden" } as const;
const NONE = "—";

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
    if (row.note) lines.push(`    ⤷ ${row.note}`);
  }
  return lines;
}

/** `UNREACHED — authored, and no scenario mounts it  (1)` */
function section(title: string, gloss: string, count: number): string {
  return `${title} — ${gloss}  (${count})`;
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
 */
export function renderCountsPlain(view: SurfaceView): string {
  return (
    `${view.counts.callable} callable, ${view.counts.disabled} visible-disabled, ` +
    `${view.counts.hidden} hidden` +
    (view.rejections.length > 0
      ? `, ${view.rejections.length} registration${view.rejections.length === 1 ? "" : "s"} rejected`
      : "")
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
export function renderSurfacePlain(
  view: SurfaceView,
  options: SurfaceRenderOptions = {},
): string {
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
 * The static catalog (`AS-COVER-001…003`). The summary says "upper bound" in so
 * many words: a tsconfig's include globs are wider than what a bundle reaches,
 * so a capability in a component no route renders any more is in here. That is
 * dead code — a different finding, not a false positive — and the reader has to
 * be told which number they are holding.
 */
export interface CatalogRenderOptions {
  /**
   * This catalog *is* the command's output, rather than its preamble.
   *
   * True at `--depth static`: there are no scenario tables and no verdict, so
   * the listing and the unread call sites have nowhere else to appear.
   *
   * False at `--depth full`, where the scenario tables below name every
   * capability a scenario reached, the `UNREACHED` section names the ones it did
   * not, and the verdict carries the unread call sites — so printing any of it
   * here is the same information a second time, above the answer instead of in
   * it. Only the summary line survives.
   */
  standalone?: boolean;
}

export function renderCatalogPlain(
  inventory: CapabilityInventory,
  options: CatalogRenderOptions = {},
): string {
  const lines: string[] = [];
  const resolved = inventory.capabilities.filter((c) => c.resolution !== "unresolved");
  const ids = authoredIds(inventory);

  lines.push(
    `${ids.size} authored (upper bound) · ${resolved.length} call site${
      resolved.length === 1 ? "" : "s"
    } across ${inventory.filesAnalyzed} file${inventory.filesAnalyzed === 1 ? "" : "s"}` +
      " · domain not analyzed, it comes from the oRPC router (OQ-1)",
  );
  if (inventory.filesOutsideRoot > 0) {
    // Relative, not absolute: plain output is byte-stable across runs
    // (`AS-CLI-003`), and an absolute path makes it machine-specific the moment
    // two people diff a CI log.
    lines.push(
      `${inventory.filesOutsideRoot} program file${
        inventory.filesOutsideRoot === 1 ? "" : "s"
      } outside the config's directory were not analyzed`,
    );
  }

  if (!options.standalone) return lines.join("\n");

  const byId = [...resolved].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  if (byId.length > 0) {
    lines.push("");
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

  const unread = renderUnread(unresolved(inventory));
  if (unread.length > 0) lines.push("", ...unread);
  return lines.join("\n");
}

/**
 * Call sites the extractor could not read. Reported with file and line, never
 * dropped: an inventory that silently omitted what it failed to parse would
 * understate the denominator, and every number built on it would claim a
 * completeness it never had.
 */
function renderUnread(entries: AuthoredCapability[]): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [];
  lines.push(
    section(
      "UNREAD CALL SITES",
      "the catalog is incomplete, so every count above is a floor",
      entries.length,
    ),
  );
  for (const capability of entries) {
    lines.push(`  ? ${capability.origin.file}:${capability.origin.line}`);
    lines.push(`      ${capability.note ?? "the extractor could not read this call site"}`);
    // The allowlist key, spelled out. It is `file#reason` rather than the line
    // the reader is looking at, so leaving them to infer it guarantees a wrong
    // guess and an entry that never matches.
    lines.push(`      allowlist key: ${unreadKey(capability)}`);
  }
  return lines;
}

/**
 * The verdict: authored minus reached (`AS-COVER-004…005`).
 *
 * This is the finding the command surface used to hide behind a fifth command,
 * so it is the last thing printed and the thing a reader stops on.
 */
export function renderCoveragePlain(report: CoverageReport): string {
  const lines: string[] = [];

  if (report.unreached.length > 0) {
    lines.push(
      section("UNREACHED", "authored, and no scenario mounts it", report.unreached.length),
    );
    lines.push(
      ...renderTable(
        ["CAPABILITY", "ORIGIN"],
        report.unreached.map((entry) => ({
          cells: [entry.capabilityId, `${entry.origin.file}:${entry.origin.line}`],
        })),
      ),
    );
    lines.push("");
  }

  if (report.undeclared.length > 0) {
    lines.push(
      section(
        "UNDECLARED",
        "present at runtime with no static origin — a dynamic registration, or a gap here",
        report.undeclared.length,
      ),
    );
    for (const id of report.undeclared) lines.push(`  ${id}`);
    lines.push("");
  }

  if (report.staleAllowlist.length > 0) {
    lines.push(
      section(
        "STALE ALLOWLIST",
        "a scenario reaches these now, so delete them before the list rots",
        report.staleAllowlist.length,
      ),
    );
    for (const id of report.staleAllowlist) lines.push(`  ${id}`);
    lines.push("");
  }

  if (report.staleUnreadAllowlist.length > 0) {
    lines.push(
      section(
        "STALE UNREAD ALLOWLIST",
        "the extractor reads these now, so delete them before the list rots",
        report.staleUnreadAllowlist.length,
      ),
    );
    for (const key of report.staleUnreadAllowlist) lines.push(`  ${key}`);
    lines.push("");
  }

  if (report.unresolved.length > 0) {
    lines.push(...renderUnread(report.unresolved), "");
  }

  lines.push(...renderCoverageSummary(report));
  return lines.join("\n");
}

/** The one line a reader who stops at the bottom takes away. */
function renderCoverageSummary(report: CoverageReport): string[] {
  const qualifiers = [
    `${report.scenarios.length} scenario${report.scenarios.length === 1 ? "" : "s"} (${report.scenarios.join(
      ", ",
    )})`,
  ];
  // Every count is relative to the scope, so the scope is printed with them
  // (`AS-CLI-007`) — `10 authored` under a scope is a claim about one prefix of
  // the codebase, not about the codebase.
  if (report.scope && report.scope.length > 0) qualifiers.push(`scope ${report.scope.join(" ")}`);

  const lines = [
    `${report.authored} authored · ${report.reached} reached · ${report.unreached.length} unreached` +
      ` · ${qualifiers.join(" · ")}`,
  ];

  if (report.domainReached.length > 0) {
    lines.push(
      `${report.domainReached.length} domain capabilit${
        report.domainReached.length === 1 ? "y" : "ies"
      } reached and held apart — that plane is the oRPC router's, and this catalog never claimed it`,
    );
  }
  if (report.allowed.length > 0) {
    lines.push(
      `${report.allowed.length} unreached capabilit${
        report.allowed.length === 1 ? "y is" : "ies are"
      } allowlisted in ${relative(process.cwd(), report.allowlistPath)}`,
    );
  }
  if (report.allowedUnread.length > 0) {
    lines.push(
      `${report.allowedUnread.length} unread call site${
        report.allowedUnread.length === 1 ? " is" : "s are"
      } allowlisted in ${relative(process.cwd(), report.unreadAllowlistPath)}`,
    );
  }
  if (report.allowlistOutOfScope > 0) {
    lines.push(
      `${report.allowlistOutOfScope} allowlist entr${
        report.allowlistOutOfScope === 1 ? "y" : "ies"
      } outside this scope were not judged either way`,
    );
  }

  // Each bucket gets its own remedy. "Add a scenario, or delete the component"
  // is the right advice for an unreached capability and useless advice for a
  // call site the extractor could not read.
  if (
    report.unreached.length === 0 &&
    report.unresolved.length === 0 &&
    report.staleAllowlist.length === 0 &&
    report.staleUnreadAllowlist.length === 0
  ) {
    lines.push(
      report.allowed.length > 0
        ? "no new surface coverage gaps — the allowlist still holds the known ones"
        : "every authored capability is reached by a scenario",
    );
  }
  return lines;
}

/**
 * Why there is no coverage verdict. Never silence: a reader who asked for the
 * complete answer and got a partial one has to be told which part is missing,
 * or the partial one reads as the complete one.
 */
export function renderNoVerdictPlain(failures: ScenarioFailure[]): string {
  return [
    section("NO COVERAGE VERDICT", "a scenario did not mount, so nothing reached anything", failures.length),
    ...failures.flatMap((failure) => [`  ${failure.scenario}`, `      ${failure.message}`]),
    "",
    "Every capability those scenarios would have surfaced would be reported unreached,",
    "so no verdict is printed at all. Fix the mount, or name a scenario that works.",
  ].join("\n");
}

export function renderFailuresPlain(failures: ScenarioFailure[]): string {
  return [
    section("DID NOT MOUNT", "these scenarios threw, and were skipped", failures.length),
    ...failures.flatMap((failure) => [`  ${failure.scenario}`, `      ${failure.message}`]),
  ].join("\n");
}

export function renderDriftPlain(scenario: string, entries: DiffEntry[]): string {
  const lines = [`  ${scenario}: ${entries.length} change${entries.length === 1 ? "" : "s"}`];
  for (const entry of entries) {
    const where = entry.subject ? `${entry.subject}  (${entry.path})` : entry.path;
    if (entry.kind === "added") lines.push(`    + ${where}  ${formatValue(entry.after)}`);
    else if (entry.kind === "removed") lines.push(`    - ${where}  ${formatValue(entry.before)}`);
    else {
      lines.push(`    ~ ${where}`);
      lines.push(`        before: ${formatValue(entry.before)}`);
      lines.push(`        after:  ${formatValue(entry.after)}`);
    }
  }
  return lines.join("\n");
}
