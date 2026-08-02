import { relative } from "node:path";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import { canonicalJson } from "@agent-surface/compiler";
import type { ContractChange } from "./diff.js";
import { changeCounts } from "./diff.js";

export type OutputFormat = "human" | "json" | "github" | "markdown";

/**
 * Presentation-only inputs. They never reach the report model, because `--json`
 * is canonical machine output and a checkout path would make it differ between
 * two machines that compiled the same source.
 */
export interface RenderOptions {
  /** Application root, used to show the snapshot path as the user typed it. */
  root?: string;
  /** Include descriptions, confirmation, policies, and tags. */
  detail?: boolean;
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

function value(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
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

function section(title: string, changes: readonly ContractChange[]): string[] {
  return [sectionTitle(title, changes), ...(changes.length > 0 ? changes.map(changeLine) : ["no changes"])];
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
  /** Description and tags, shown under --detail. */
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

/**
 * What a compiled contract cannot tell you. The columns above are declarations
 * the graph proves are reachable — not a transcript of a run, and a policy's
 * verdict is not knowable until there is an actor and an input to judge.
 */
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

/** Show the snapshot where the user would type it, not as an absolute path. */
export function displayPath(path: string, root?: string): string {
  if (!root) return path;
  const relativePath = relative(root, path);
  return !relativePath || relativePath.startsWith("..") ? path : relativePath;
}

/**
 * `inspect` exists to show the inventory. The other commands lead with a
 * verdict and keep it out of the way — until `--detail` is asked for, because
 * the reason to ask a gate for detail is to read what it gated.
 */
export function showsContract(report: ContractReport, options: RenderOptions = {}): boolean {
  return report.command === "inspect" || options.detail === true;
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

export function humanReport(report: ContractReport, options: RenderOptions = {}): string {
  const fields = summaryFields(report, options);
  const label = Math.max(...fields.map(([name]) => name.length));
  const lines = [
    `AGENT SURFACE ${report.command.toUpperCase()} · ${report.status.toUpperCase()}`,
    "",
    ...headline(report.manifest),
    "",
    ...fields.map(([name, value]) => `${name.padEnd(label)}  ${value}`),
  ];
  if (report.integrity) lines.push("", ...section("SOURCE ↔ SNAPSHOT", report.integrity.changes));
  if (report.pullRequest) {
    lines.push("", ...section(`PR DRIFT vs ${report.pullRequest.base}`, report.pullRequest.changes));
  }
  if (showsContract(report, options)) {
    const widths = contractColumns(report.manifest.capabilities);
    lines.push("", contractHeading(report.manifest), "", `  ${contractLine(CONTRACT_HEADERS, widths)}`);
    for (const group of groupByDeclaration(report.manifest.capabilities)) {
      lines.push("", `${group.declarationId} (${group.entries.length})`);
      for (const entry of group.entries) {
        const row = contractRow(entry);
        lines.push(`  ${contractLine(contractCells(row), widths)}`);
        if (options.detail && row.note) lines.push(`      ${row.note}`);
      }
    }
    lines.push("", ...CONTRACT_CAVEAT);
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
