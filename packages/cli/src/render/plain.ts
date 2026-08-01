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
  /** Authoritative domain manifest entries, when runtime config was loaded. */
  domainCapabilities?: number;
  /** Show origins, notes and per-site allowlist keys. */
  detail?: boolean;
}

function componentOf(capabilityId: string): string {
  const path = capabilityId.replace(/^(view|domain):/, "");
  const dot = path.lastIndexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

export function renderCatalogPlain(
  inventory: CapabilityInventory,
  options: CatalogRenderOptions = {},
): string {
  const lines: string[] = [];
  const resolved = inventory.capabilities.filter((c) => c.resolution !== "unresolved");
  const unreadEntries = unresolved(inventory);
  const dynamicMetadata = resolved.filter((c) => c.resolution === "partial").length;
  const ids = authoredIds(inventory);
  const authored = ids.size + (options.domainCapabilities ?? 0);

  lines.push("STATIC CATALOG");
  lines.push(
    `STATUS        ${unreadEntries.length > 0 ? "INCOMPLETE" : "COMPLETE"}${
      unreadEntries.length > 0
        ? ` — ${unreadEntries.length} unread capability identit${unreadEntries.length === 1 ? "y" : "ies"}`
        : " — every capability identity resolved"
    }`,
  );
  lines.push(
    `Capabilities  ${authored} authored (upper bound) · ${resolved.length} resolved call site${
      resolved.length === 1 ? "" : "s"
    }`,
  );
  lines.push(
    `Program       ${inventory.filesAnalyzed} file${inventory.filesAnalyzed === 1 ? "" : "s"} analyzed` +
      (inventory.filesOutsideRoot > 0
        ? ` · ${inventory.filesOutsideRoot} agent-surface implementation file${
            inventory.filesOutsideRoot === 1 ? "" : "s"
          } excluded`
        : ""),
  );
  lines.push(
    `Metadata      ${dynamicMetadata} call site${dynamicMetadata === 1 ? "" : "s"} partially read` +
      (dynamicMetadata > 0 ? " · identity remains resolved" : ""),
  );
  lines.push(
    options.domainCapabilities === undefined
      ? "Domain        not analyzed at static depth; full depth reads the oRPC manifest"
      : `Domain        ${options.domainCapabilities} manifest capabilit${
          options.domainCapabilities === 1 ? "y" : "ies"
        }`,
  );

  if (!options.standalone) return lines.join("\n");

  const components = new Map<
    string,
    { ids: Set<string>; sites: number; partial: number }
  >();
  for (const capability of resolved) {
    const component = componentOf(capability.capabilityId);
    const current = components.get(component) ?? { ids: new Set<string>(), sites: 0, partial: 0 };
    current.ids.add(capability.capabilityId);
    current.sites += 1;
    if (capability.resolution === "partial") current.partial += 1;
    components.set(component, current);
  }

  if (components.size > 0) {
    lines.push("");
    lines.push(`COMPONENTS  (${components.size})`);
    lines.push(
      ...renderTable(
        ["COMPONENT", "CAPABILITIES", "CALL SITES", "DYNAMIC META"],
        [...components.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([component, data]) => ({
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
    lines.push("");
    lines.push(`UNREAD SITES  (${unreadEntries.length})`);
    lines.push("Counts above are a floor until these sites are resolved or explicitly accepted.");
    lines.push(
      ...renderTable(
        ["FILE", "REASON", "SITES"],
        [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
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
      lines.push("");
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
    const unread = renderUnread(unreadEntries);
    if (unread.length > 0) lines.push("", ...unread);
  } else if (unreadEntries.length > 0 || resolved.length > 0) {
    lines.push("");
    lines.push(
      "Details: re-run with --detail for origins, metadata diagnostics, and allowlist keys.",
    );
  }
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
    // The allowlist key, spelled out. It is `file#reason#site`, and the site is
    // a hash — not the line the reader is looking at — so leaving them to infer
    // it guarantees a wrong guess and an entry that never matches.
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
export interface CoverageRenderOptions {
  /** Check already prints an executive summary; render findings only. */
  compact?: boolean;
  /** Include non-gating inventories such as undeclared runtime ids. */
  detail?: boolean;
}

export function renderCoveragePlain(
  report: CoverageReport,
  options: CoverageRenderOptions = {},
): string {
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
    if (!options.compact || options.detail) {
      lines.push(
        section(
          "UNDECLARED",
          "present at runtime with no static origin — a dynamic registration, or a gap here",
          report.undeclared.length,
        ),
      );
      for (const id of report.undeclared) lines.push(`  ${id}`);
    } else {
      lines.push(
        `NOTICE — ${report.undeclared.length} runtime capabilit${
          report.undeclared.length === 1 ? "y has" : "ies have"
        } no static origin; re-run check with --detail to list them.`,
      );
    }
    lines.push("");
  }

  if (report.unmanifestedDomain.length > 0) {
    lines.push(
      section(
        "UNMANIFESTED DOMAIN",
        "mounted, but absent from the authoritative oRPC manifest",
        report.unmanifestedDomain.length,
      ),
    );
    for (const id of report.unmanifestedDomain) lines.push(`  ${id}`);
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

  if (!options.compact) lines.push(...renderCoverageSummary(report));
  return lines.join("\n");
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
}

function overviewRow(label: string, status: "PASS" | "WARN" | "FAIL" | "ERROR", text: string): string {
  return `${label.padEnd(12)}${status.padEnd(7)}${text}`;
}

function wrappedList(items: string[]): string[] {
  const prefix = "  ";
  return wrapText(items.join(", "), REPORT_WIDTH - prefix.length).map((line) => `${prefix}${line}`);
}

/** First-screen answer for `check`: verdict and health dimensions before detail. */
export function renderCheckOverviewPlain(input: CheckOverview): string {
  const lines = [`SURFACE CHECK  ${input.status}`, ""];
  const coverage = input.coverage;
  if (coverage) {
    const coverageStatus =
      coverage.unreached.length > 0 || coverage.staleAllowlist.length > 0
        ? "FAIL"
        : coverage.allowed.length > 0
          ? "WARN"
          : "PASS";
    lines.push(
      overviewRow(
        "Coverage",
        coverageStatus,
        `${coverage.reached}/${coverage.authored} authored capabilities reached` +
          (coverage.unreached.length > 0 ? ` · ${coverage.unreached.length} unreached` : "") +
          (coverage.allowed.length > 0
            ? ` · ${coverage.allowed.length} unreached allowlisted`
            : "") +
          (coverage.staleAllowlist.length > 0
            ? ` · ${coverage.staleAllowlist.length} stale allowlist entr${
                coverage.staleAllowlist.length === 1 ? "y" : "ies"
              }`
            : ""),
      ),
    );
    const unread = coverage.unresolved.length;
    const accepted = coverage.allowedUnread.length;
    const catalogStatus =
      coverage.staleUnreadAllowlist.length > 0 || (unread > 0 && !input.unresolvedAllowed)
        ? "FAIL"
        : unread > 0 || accepted > 0
          ? "WARN"
          : "PASS";
    lines.push(
      overviewRow(
        "Catalog",
        catalogStatus,
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
      ),
    );
    lines.push(
      overviewRow(
        "Domain",
        coverage.unmanifestedDomain.length > 0 ? "FAIL" : coverage.domainAuthoritative ? "PASS" : "WARN",
        coverage.unmanifestedDomain.length > 0
          ? `${coverage.unmanifestedDomain.length} mounted capabilit${
              coverage.unmanifestedDomain.length === 1 ? "y" : "ies"
            } absent from manifest`
          : coverage.domainAuthoritative
          ? `${coverage.domainReached.length} manifest capabilit${
              coverage.domainReached.length === 1 ? "y" : "ies"
            } reached`
          : "authoritative manifest not configured",
      ),
    );
  } else {
    lines.push(
      overviewRow(
        "Coverage",
        input.status === "ERROR" ? "ERROR" : "WARN",
        input.status === "ERROR"
          ? "no verdict; runtime analysis incomplete"
          : "not evaluated — statement about these scenarios only; re-run with --depth full",
      ),
    );
  }

  const baselineOk = input.baselineCurrent === input.baselineTotal && input.scenarioManifestOk;
  lines.push(
    overviewRow(
      "Baselines",
      baselineOk ? "PASS" : "FAIL",
      `${input.baselineCurrent}/${input.baselineTotal} scenario baselines current` +
        (input.scenarioManifestOk ? "" : " · scenario manifest differs"),
    ),
  );
  lines.push(
    overviewRow(
      "Runtime",
      input.mountFailures > 0 ? "ERROR" : input.rejected > 0 ? "FAIL" : "PASS",
      input.mountFailures > 0
        ? `${input.mountFailures} scenario${input.mountFailures === 1 ? "" : "s"} did not mount`
        : input.rejected > 0
          ? `${input.rejected} registration${input.rejected === 1 ? "" : "s"} rejected`
          : `${input.scenarios.length} scenario${input.scenarios.length === 1 ? "" : "s"} mounted`,
    ),
  );
  lines.push("", `SCENARIOS  (${input.scenarios.length})`, ...wrappedList(input.scenarios));
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
      } reached${
        report.domainAuthoritative
          ? " against the authoritative oRPC manifest"
          : " and held apart — configure the authoritative oRPC manifest to cover that plane"
      }`,
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
    report.staleUnreadAllowlist.length === 0 &&
    report.unmanifestedDomain.length === 0
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
