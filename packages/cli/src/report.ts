import type { CapabilityContractManifest } from "@agent-surface/core";
import { canonicalJson } from "@agent-surface/compiler";
import type { ContractChange } from "./diff.js";
import { changeCounts } from "./diff.js";

export type OutputFormat = "human" | "json" | "github" | "markdown";

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

function section(title: string, changes: readonly ContractChange[]): string[] {
  const counts = changeCounts(changes);
  return [
    `${title} (${changes.length}) · widening ${counts.widening} · narrowing ${counts.narrowing} · neutral ${counts.neutral}`,
    ...(changes.length > 0 ? changes.map(changeLine) : ["no changes"]),
  ];
}

export function humanReport(report: ContractReport): string {
  const lines = [
    `AGENT SURFACE ${report.command.toUpperCase()} · ${report.status.toUpperCase()}`,
    `Contract      ${report.manifest.hash}`,
    `Completeness  ${report.manifest.completeness.status}`,
    `Targets       ${report.manifest.targets.join(", ") || "—"}`,
    `Capabilities  ${report.manifest.capabilities.length}`,
    `Snapshot      ${report.snapshotPath}`,
  ];
  if (report.integrity) {
    lines.push(`Integrity     ${report.integrity.status}`);
    lines.push("", ...section("SOURCE ↔ SNAPSHOT", report.integrity.changes));
  }
  if (report.pullRequest) {
    lines.push("", ...section(`PR DRIFT vs ${report.pullRequest.base}`, report.pullRequest.changes));
  }
  if (report.command === "inspect") {
    lines.push("", "REPOSITORY CONTRACT");
    for (const entry of report.manifest.capabilities) {
      lines.push(
        `${entry.capabilityId} · ${entry.kind} · ${entry.effect} · ${entry.declarationId} · ${entry.targets.join(",")}`,
      );
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

export function renderReport(report: ContractReport, format: OutputFormat): string {
  if (format === "json") return canonicalJson(report, true);
  if (format === "markdown") return markdownReport(report);
  if (format === "github") return markdownReport(report, true);
  return humanReport(report);
}
