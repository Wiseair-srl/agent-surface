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

/**
 * The obligations attached to a capability, which are the reason to read a
 * contract at all. A `never` confirmation is a deliberate lowering, so it is
 * only worth a marker under --detail alongside everything else that is set.
 */
export function markers(entry: CapabilityContractEntry, detail = false): string[] {
  const marks: string[] = [];
  if (entry.confirmation && (detail || entry.confirmation !== "never")) marks.push(`confirm:${entry.confirmation}`);
  for (const policy of entry.policies ?? []) marks.push(`policy:${policy.name}${policy.phase ? `@${policy.phase}` : ""}`);
  if (detail) for (const tag of entry.tags ?? []) marks.push(`#${tag}`);
  return marks;
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

/** Column widths shared by the plain and drawn renderers, so both align alike. */
export function contractColumns(capabilities: readonly CapabilityContractEntry[]): {
  id: number;
  kind: number;
  effect: number;
} {
  return {
    id: Math.max(0, ...capabilities.map((entry) => entry.capabilityId.length)),
    kind: Math.max(0, ...capabilities.map((entry) => entry.kind.length)),
    effect: Math.max(0, ...capabilities.map((entry) => entry.effect.length)),
  };
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

export function summaryFields(report: ContractReport, options: RenderOptions = {}): [string, string][] {
  const { manifest } = report;
  const kinds = tally(manifest.capabilities.map((entry) => entry.kind));
  const effects = tally(manifest.capabilities.map((entry) => entry.effect));
  const fields: [string, string][] = [
    ["Contract", manifest.hash],
    ["Compiler", manifest.compilerVersion],
    ["Completeness", manifest.completeness.status],
    ["Targets", manifest.targets.join(", ") || "—"],
    ["Capabilities", `${manifest.capabilities.length}${kinds ? ` · ${kinds}` : ""}`],
    ...(effects ? ([["Effects", effects]] as [string, string][]) : []),
    ["Snapshot", displayPath(report.snapshotPath, options.root)],
  ];
  if (report.integrity) fields.push(["Integrity", report.integrity.status]);
  return fields;
}

export function humanReport(report: ContractReport, options: RenderOptions = {}): string {
  const label = Math.max(...summaryFields(report, options).map(([name]) => name.length));
  const lines = [
    `AGENT SURFACE ${report.command.toUpperCase()} · ${report.status.toUpperCase()}`,
    ...summaryFields(report, options).map(([name, value]) => `${name.padEnd(label)}  ${value}`),
  ];
  if (report.integrity) lines.push("", ...section("SOURCE ↔ SNAPSHOT", report.integrity.changes));
  if (report.pullRequest) {
    lines.push("", ...section(`PR DRIFT vs ${report.pullRequest.base}`, report.pullRequest.changes));
  }
  if (showsContract(report, options)) {
    const column = contractColumns(report.manifest.capabilities);
    lines.push("", contractHeading(report.manifest));
    for (const group of groupByDeclaration(report.manifest.capabilities)) {
      lines.push("", `${group.declarationId} (${group.entries.length})`);
      for (const entry of group.entries) {
        const marks = markers(entry, options.detail);
        lines.push(
          `  ${entry.capabilityId.padEnd(column.id)}  ${entry.kind.padEnd(column.kind)}  ${
            marks.length > 0 ? entry.effect.padEnd(column.effect) : entry.effect
          }${marks.length > 0 ? `  ${marks.join(" ")}` : ""}`.trimEnd(),
        );
        if (options.detail && entry.description) lines.push(`      ${entry.description}`);
      }
    }
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
