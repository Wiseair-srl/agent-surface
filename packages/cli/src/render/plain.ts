import type { CapabilityRow, SurfaceView } from "./model.js";
import type { DiffEntry } from "../baseline.js";
import { formatValue } from "../baseline.js";

/**
 * The no-colour, no-cursor rendering used when stdout is piped or when
 * `--plain`, `CI` or `NO_COLOR` is set. Same view model as the Ink UI, so the
 * two cannot disagree about what the surface contains.
 */

const MARK = { expose: "+", disable: "~", hide: "-" } as const;

function renderRow(row: CapabilityRow, lines: string[]): void {
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
        const phases = policy.phases.length > 0 ? policy.phases.join("/") : "—";
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

export function renderSurfacePlain(view: SurfaceView): string {
  const lines: string[] = [];
  lines.push(`scenario ${view.scenario}${view.route ? `  route ${view.route}` : ""}`);
  lines.push(
    `${view.counts.callable} callable, ${view.counts.disabled} visible-disabled${
      view.explained ? `, ${view.counts.hidden} hidden` : ""
    }`,
  );

  const populated = view.groups.filter((group) => group.rows.length > 0);
  if (populated.length === 0) {
    lines.push("");
    lines.push("Nothing is registered for this scenario — the agent has no surface here.");
    if (!view.explained) {
      lines.push("Re-run with --explain to see whether a policy hid it.");
    }
    return lines.join("\n");
  }

  for (const group of populated) {
    lines.push("");
    lines.push(`${group.heading}  (${group.rows.length})`);
    for (const row of group.rows) renderRow(row, lines);
  }
  return lines.join("\n");
}

export function renderDiffPlain(scenario: string, entries: DiffEntry[]): string {
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
  return lines.join("\n");
}
