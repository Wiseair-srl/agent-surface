import { relative } from "node:path";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import { canonicalJson } from "@agent-surface/compiler";
import type { ContractChange } from "./diff.js";
import { changeCounts } from "./diff.js";

export type OutputFormat = "human" | "json" | "github" | "markdown";

/**
 * How much of the report the human renderers show. `normal` is the compact
 * inventory; `min` stops at the headline and counts; `detail` adds provenance,
 * descriptions and the grouped view. Machine formats ignore the knob: `--json`
 * always carries every field.
 */
export type Verbosity = "min" | "normal" | "detail";

/**
 * Presentation-only inputs. They never reach the report model, because `--json`
 * is canonical machine output and a checkout path would make it differ between
 * two machines that compiled the same source.
 */
export interface RenderOptions {
  /** Application root, used to show the snapshot path as the user typed it. */
  root?: string;
  /** Deprecated alias for `verbosity: "detail"`, kept for the exported API. */
  detail?: boolean;
  /** Human renderings only; `min` and `detail` widen or narrow the same blocks. */
  verbosity?: Verbosity;
  /** Paint with ANSI. Off by default so piped output stays byte-stable. */
  color?: boolean;
}

export function verbosityOf(options: RenderOptions): Verbosity {
  return options.verbosity ?? (options.detail ? "detail" : "normal");
}

export interface ContractReport {
  command: "inspect" | "check" | "snapshot";
  status: "pass" | "fail" | "written" | "view";
  manifest: CapabilityContractManifest;
  snapshotPath: string;
  integrity?: {
    status: "current" | "missing" | "stale";
    changes: ContractChange[];
  };
  pullRequest?: {
    base: string;
    changes: ContractChange[];
  };
}

/**
 * The same eight ANSI styles the sibling `orpc-agent` CLI paints with, so the
 * two inventories read alike. Colour is applied after padding and only when
 * the caller asked for it: the tested contract stays the uncoloured bytes.
 */
const ANSI: Record<string, string> = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
};

export function supportsColor(stream: { isTTY?: boolean }): boolean {
  return (
    stream.isTTY === true &&
    !process.env["CI"] &&
    !process.env["NO_COLOR"] &&
    process.env["TERM"] !== "dumb"
  );
}

function painter(options: RenderOptions): (text: string, style?: string) => string {
  if (!options.color) return (text) => text;
  return (text, style) => (style ? `${ANSI[style] ?? ""}${text}${ANSI.reset}` : text);
}

function value(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

/** The classification colour, shared by the plain and drawn change rows. */
export function changeStyle(change: ContractChange): string {
  if (change.classification === "widening") return "yellow";
  if (change.classification === "narrowing") return "cyan";
  return "gray";
}

function changeLine(change: ContractChange): string {
  const mark = change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~";
  return `${mark} ${change.classification.padEnd(9)} ${change.capabilityId} · ${change.declarationId} · ${change.field}${
    change.kind === "changed" ? `: ${value(change.before)} → ${value(change.after)}` : ""
  }`;
}

export function sectionTitle(title: string, changes: readonly ContractChange[]): string {
  const counts = changeCounts(changes);
  return `${title} (${changes.length}) · widening ${counts.widening} · narrowing ${counts.narrowing} · neutral ${counts.neutral}`;
}

function section(
  title: string,
  changes: readonly ContractChange[],
  options: RenderOptions,
  rows: boolean,
): string[] {
  const paint = painter(options);
  const lines = [paint(sectionTitle(title, changes), "bold")];
  if (!rows) return lines;
  if (changes.length === 0) return [...lines, paint("no changes", "dim")];
  return [...lines, ...changes.map((change) => paint(changeLine(change), changeStyle(change)))];
}

/**
 * Effects in escalating order of reach, so a renderer can grade one without
 * restating the vocabulary. Anything unknown sorts last: a capability whose
 * effect this CLI does not recognize is the one worth looking at.
 */
const EFFECT_ORDER = [
  "read",
  "local-state",
  "navigation",
  "server-query",
  "server-mutation",
  "external-side-effect",
  "destructive",
] as const;

export function effectRank(effect: string): number {
  const index = EFFECT_ORDER.indexOf(effect as (typeof EFFECT_ORDER)[number]);
  return index === -1 ? EFFECT_ORDER.length : index;
}

export interface ContractGroup {
  declarationId: string;
  entries: CapabilityContractEntry[];
}

/** Capabilities grouped by the declaration that owns them, input order kept. */
export function groupByDeclaration(capabilities: readonly CapabilityContractEntry[]): ContractGroup[] {
  const groups = new Map<string, CapabilityContractEntry[]>();
  for (const entry of capabilities) {
    const existing = groups.get(entry.declarationId);
    if (existing) existing.push(entry);
    else groups.set(entry.declarationId, [entry]);
  }
  return [...groups].map(([declarationId, entries]) => ({ declarationId, entries }));
}

export type Reach = "low" | "medium" | "high";

/**
 * The effect ladder, graded. The effect is the fact; the grade is how it reads
 * to someone who has not memorised the ladder. It is printed as a word rather
 * than left to colour alone, because the streams that matter most — a pipe, a
 * CI log, `--plain` — have no colour to read.
 */
export function reachOf(effect: string): Reach {
  const rank = effectRank(effect);
  if (rank <= 1) return "low";
  if (rank <= 3) return "medium";
  return "high";
}

/**
 * Colour vocabulary shared with the drawn view, one hue per fact. The scale
 * matches the sibling `orpc-agent` CLI: reads cool, writes warm, destructive
 * red, external magenta — so a reader who knows one CLI can skim the other.
 */
export const REACH_COLOR: Record<Reach, string> = { low: "green", medium: "yellow", high: "red" };

export const EFFECT_COLOR: Record<string, string> = {
  read: "cyan",
  "local-state": "gray",
  navigation: "blue",
  "server-query": "cyan",
  "server-mutation": "yellow",
  "external-side-effect": "magenta",
  destructive: "red",
};

export function confirmStyle(confirm: string): string | undefined {
  if (confirm === "required") return "green";
  if (confirm === "optional") return "cyan";
  return "dim";
}

/** Nothing declared. A column still has to read as a column. */
const NONE = "—";

export const CONTRACT_HEADERS = ["CAPABILITY", "KIND", "EFFECT", "REACH", "CONFIRM", "POLICIES"] as const;

export interface ContractRow {
  capabilityId: string;
  kind: string;
  effect: string;
  reach: Reach;
  confirm: string;
  policies: string;
  /** Description and tags, shown under detail verbosity. */
  note: string;
}

export function contractRow(entry: CapabilityContractEntry): ContractRow {
  const policies = (entry.policies ?? []).map((policy) => `${policy.name}${policy.phase ? `@${policy.phase}` : ""}`);
  const tags = (entry.tags ?? []).map((tag) => `#${tag}`).join(" ");
  return {
    capabilityId: entry.capabilityId,
    kind: entry.kind,
    effect: entry.effect,
    reach: reachOf(entry.effect),
    confirm: entry.confirmation ?? NONE,
    policies: policies.length > 0 ? policies.join(", ") : NONE,
    note: [entry.description, tags].filter(Boolean).join("  "),
  };
}

export function contractCells(row: ContractRow): string[] {
  return [row.capabilityId, row.kind, row.effect, row.reach, row.confirm, row.policies];
}

function tally(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} ${name}`)
    .join(" · ");
}

function plural(count: number, noun: string, suffix = "s"): string {
  return `${count} ${noun}${count === 1 ? "" : suffix}`;
}

export function contractHeading(manifest: CapabilityContractManifest): string {
  const count = manifest.capabilities.length;
  const groups = groupByDeclaration(manifest.capabilities).length;
  return `REPOSITORY CONTRACT · ${count} ${count === 1 ? "capability" : "capabilities"} · ${plural(groups, "declaration")}`;
}

/**
 * The answer, before the evidence for it. A reader who stops after this line
 * should still know how large the surface is and how much of it is gated.
 */
export function headline(manifest: CapabilityContractManifest): string[] {
  const capabilities = manifest.capabilities;
  const count = capabilities.length;
  const gated = capabilities.filter((entry) => entry.confirmation && entry.confirmation !== "never").length;
  const policed = capabilities.filter((entry) => (entry.policies ?? []).length > 0).length;
  // Along the ladder, not by frequency: "34 low · 1 high · 1 medium" reads as
  // a miscount rather than a distribution.
  const reach = (["low", "medium", "high"] as const)
    .map((grade) => [grade, capabilities.filter((entry) => reachOf(entry.effect) === grade).length] as const)
    .filter(([, count]) => count > 0)
    .map(([grade, count]) => `${count} ${grade}`)
    .join(" · ");
  return [
    `${count} ${count === 1 ? "capability" : "capabilities"} · ${plural(
      groupByDeclaration(capabilities).length,
      "declaration",
    )}${count > 0 ? ` · ${tally(capabilities.map((entry) => entry.kind))}` : ""}`,
    `reach ${reach || NONE} · declared gates: ${gated} confirmation · ${policed} policy`,
  ];
}

/** The integrity word for the headline, so `min` still answers "am I current". */
export function integrityWord(report: ContractReport): string | undefined {
  if (!report.integrity) return undefined;
  return `snapshot ${report.integrity.status}`;
}

/**
 * What a compiled contract cannot tell you, in two lines the compact view can
 * afford. The columns are declarations the graph proves reachable — not a
 * transcript of a run.
 */
export const CONTRACT_CAVEAT_SHORT = [
  "Declared contract, compiled from the production graph — what this code can expose,",
  "not what a mount exposed at runtime; a policy's verdict needs a real invocation.",
];

/** The full statement, kept for detail verbosity where prose has room. */
export const CONTRACT_CAVEAT = [
  "Declarations, compiled from the production graph — what this code can expose,",
  "not what a mount exposed at runtime. CONFIRM and POLICIES are declared per",
  "capability; whether a policy admits, denies or hides one depends on the actor,",
  "input and context of a real invocation, which this command never performs.",
];

/** Column widths shared by the plain and drawn renderers, so both align alike. */
export function contractColumns(capabilities: readonly CapabilityContractEntry[]): number[] {
  const rows = capabilities.map((entry) => contractCells(contractRow(entry)));
  return CONTRACT_HEADERS.map((header, index) =>
    Math.max(header.length, ...rows.map((cells) => cells[index]?.length ?? 0)),
  );
}

/** One table line, padded to the shared widths. The last cell is never padded. */
export function contractLine(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
    .join("  ")
    .trimEnd();
}

/** A table row, each cell padded then painted so the grid survives the colour. */
function paintedRow(row: ContractRow, widths: readonly number[], options: RenderOptions): string {
  const paint = painter(options);
  const cells = contractCells(row).map((cell, index) => (index === 5 ? cell : cell.padEnd(widths[index] ?? 0)));
  return [
    cells[0],
    paint(cells[1] ?? "", "dim"),
    paint(cells[2] ?? "", EFFECT_COLOR[row.effect]),
    paint(cells[3] ?? "", REACH_COLOR[row.reach]),
    paint(cells[4] ?? "", confirmStyle(row.confirm)),
    row.policies === NONE ? paint(cells[5] ?? "", "dim") : cells[5],
  ]
    .join("  ")
    .trimEnd();
}

/** Show the snapshot where the user would type it, not as an absolute path. */
export function displayPath(path: string, root?: string): string {
  if (!root) return path;
  const relativePath = relative(root, path);
  return !relativePath || relativePath.startsWith("..") ? path : relativePath;
}

/** How the inventory table is drawn, per command and verbosity. */
export type ContractView = "none" | "flat" | "grouped";

/**
 * `inspect` exists to show the inventory: compact and flat by default, grouped
 * by declaration under detail. The other commands lead with a verdict and keep
 * the inventory out of the way — until detail is asked for, because the reason
 * to ask a gate for detail is to read what it gated.
 */
export function contractView(report: ContractReport, options: RenderOptions = {}): ContractView {
  const verbosity = verbosityOf(options);
  if (verbosity === "detail") return "grouped";
  if (report.command !== "inspect" || verbosity === "min") return "none";
  return "flat";
}

/** Kept for the exported API; true whenever any inventory is rendered. */
export function showsContract(report: ContractReport, options: RenderOptions = {}): boolean {
  return contractView(report, options) !== "none";
}

/** Provenance. True, needed, and not what the reader came for — so it sits below. */
export function summaryFields(report: ContractReport, options: RenderOptions = {}): [string, string][] {
  const { manifest } = report;
  const fields: [string, string][] = [
    ["Contract", manifest.hash],
    ["Compiler", manifest.compilerVersion],
    ["Completeness", manifest.completeness.status],
    ["Targets", manifest.targets.join(", ") || NONE],
    ["Snapshot", displayPath(report.snapshotPath, options.root)],
  ];
  if (report.integrity) fields.push(["Integrity", report.integrity.status]);
  return fields;
}

function bannerLine(report: ContractReport, options: RenderOptions): string {
  const paint = painter(options);
  const ok = report.status !== "fail";
  return paint(
    `AGENT SURFACE ${report.command.toUpperCase()} · ${report.status.toUpperCase()}`,
    ok ? "green" : "red",
  );
}

function headlineLines(report: ContractReport, options: RenderOptions): string[] {
  const paint = painter(options);
  const [size, gates] = headline(report.manifest);
  const integrity = integrityWord(report);
  const stale = report.integrity && report.integrity.status !== "current";
  return [
    paint(size ?? "", "bold"),
    `${gates}${integrity ? ` · ${stale ? paint(integrity, "yellow") : integrity}` : ""}`,
  ];
}

function flatContract(manifest: CapabilityContractManifest, options: RenderOptions): string[] {
  const paint = painter(options);
  const widths = contractColumns(manifest.capabilities);
  return [
    paint(contractLine(CONTRACT_HEADERS, widths), "dim"),
    ...manifest.capabilities.map((entry) => paintedRow(contractRow(entry), widths, options)),
  ];
}

function groupedContract(manifest: CapabilityContractManifest, options: RenderOptions): string[] {
  const paint = painter(options);
  const widths = contractColumns(manifest.capabilities);
  const lines = [
    paint(contractHeading(manifest), "bold"),
    "",
    `  ${paint(contractLine(CONTRACT_HEADERS, widths), "dim")}`,
  ];
  for (const group of groupByDeclaration(manifest.capabilities)) {
    lines.push("", `${paint(group.declarationId, "blue")} (${group.entries.length})`);
    for (const entry of group.entries) {
      const row = contractRow(entry);
      lines.push(`  ${paintedRow(row, widths, options)}`);
      if (row.note) lines.push(paint(`      ${row.note}`, "dim"));
    }
  }
  return lines;
}

/**
 * One human report for every command; verbosity widens or narrows blocks
 * rather than swapping layouts. `min` stops after the headline and change
 * counts; `detail` adds provenance fields, the grouped inventory with notes,
 * and the full caveat.
 */
export function humanReport(report: ContractReport, options: RenderOptions = {}): string {
  const paint = painter(options);
  const verbosity = verbosityOf(options);
  const view = contractView(report, options);
  const lines: string[] = [];

  // `inspect` leads with the inventory itself; a verdict banner would restate
  // the exit code. The writing and gating commands lead with theirs.
  if (report.command !== "inspect" || verbosity === "detail") {
    lines.push(bannerLine(report, options), "");
  }
  lines.push(...headlineLines(report, options));

  if (report.command === "snapshot") {
    lines.push("", `wrote ${displayPath(report.snapshotPath, options.root)}`);
  }

  if (verbosity === "detail") {
    const fields = summaryFields(report, options);
    const label = Math.max(...fields.map(([name]) => name.length));
    lines.push("", ...fields.map(([name, value]) => `${paint(name.padEnd(label), "dim")}  ${value}`));
  }

  // `min` keeps section titles — the counts are the point — and drops rows.
  // Under `normal`, inspect shows integrity rows only when there is drift;
  // an explicit --base always gets its answer, even when that answer is none.
  const rows = verbosity !== "min";
  if (report.integrity && (report.command === "check" || verbosity === "detail" || report.integrity.changes.length > 0)) {
    lines.push("", ...section("SOURCE ↔ SNAPSHOT", report.integrity.changes, options, rows));
  }
  if (report.pullRequest) {
    lines.push("", ...section(`PR DRIFT vs ${report.pullRequest.base}`, report.pullRequest.changes, options, rows));
  }

  if (view === "flat") {
    lines.push("", ...flatContract(report.manifest, options));
    lines.push("", ...CONTRACT_CAVEAT_SHORT.map((line) => paint(line, "dim")));
  } else if (view === "grouped") {
    lines.push("", ...groupedContract(report.manifest, options));
    lines.push("", ...CONTRACT_CAVEAT.map((line) => paint(line, "dim")));
  }
  return `${lines.join("\n")}\n`;
}

function markdownChanges(changes: readonly ContractChange[]): string {
  if (changes.length === 0) return "No changes.\n";
  return [
    "| Class | Change | Capability | Declaration | Field |",
    "|---|---|---|---|---|",
    ...changes.map(
      (change) =>
        `| ${change.classification} | ${change.kind} | \`${change.capabilityId}\` | \`${change.declarationId}\` | \`${change.field}\` |`,
    ),
  ].join("\n");
}

export function markdownReport(report: ContractReport, github = false): string {
  const lines = [
    `## Agent Surface ${report.command} — ${report.status}`,
    "",
    `- Contract: \`${report.manifest.hash}\``,
    `- Completeness: **${report.manifest.completeness.status}**`,
    `- Capabilities: **${report.manifest.capabilities.length}**`,
    `- Targets: ${report.manifest.targets.map((target) => `\`${target}\``).join(", ") || "—"}`,
  ];
  if (report.integrity) {
    lines.push("", `### Source ↔ snapshot — ${report.integrity.status}`, "", markdownChanges(report.integrity.changes));
  }
  if (report.pullRequest) {
    lines.push("", `### PR drift vs \`${report.pullRequest.base}\``, "", markdownChanges(report.pullRequest.changes));
  }
  if (github && report.status === "fail") {
    lines.unshift(`::error title=Agent Surface contract drift::${report.integrity?.changes.length ?? 0} integrity change(s)`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderReport(report: ContractReport, format: OutputFormat, options: RenderOptions = {}): string {
  if (format === "json") return canonicalJson(report, true);
  if (format === "markdown") return markdownReport(report);
  if (format === "github") return markdownReport(report, true);
  return humanReport(report, options);
}
