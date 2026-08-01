import type { CapabilityRow, SurfaceView } from "./model.js";
import type { DiffEntry } from "../baseline.js";
import { formatValue } from "../baseline.js";
import { authoredIds, unresolved, type CapabilityInventory } from "../extract.js";
import type { CoverageReport } from "../coverage.js";

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

/**
 * The counts line, and everything it is relative to (`AS-CLI-007`).
 *
 * `hidden` is printed unconditionally. It is computed on every run — the
 * explanation is always collected — and suppressing it outside `--explain`
 * meant a surface with a policy-hidden half rendered as a complete one. The
 * *attribution* still needs `--explain`; only the count moved.
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

function renderRejections(view: SurfaceView, lines: string[]): void {
  if (view.rejections.length === 0) return;
  lines.push("");
  lines.push(`rejected during mount  (${view.rejections.length})`);
  for (const rejection of view.rejections) {
    const why =
      rejection.reason === "duplicate"
        ? "duplicate — an earlier registration holds this key"
        : "guard — onRegister rejected this registration";
    lines.push(`  ! ${rejection.componentType} (${rejection.instanceId})  ${why}`);
  }
}

export function renderSurfacePlain(view: SurfaceView): string {
  const lines: string[] = [];
  lines.push(
    `scenario ${view.scenario}${view.route ? `  route ${view.route}` : ""}${
      view.scope && view.scope.length > 0 ? `  scope ${view.scope.join(" ")}` : ""
    }`,
  );
  lines.push(renderCountsPlain(view));

  renderRejections(view, lines);

  const populated = view.groups.filter((group) => group.rows.length > 0);
  if (populated.length === 0) {
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
      if (!view.explained) {
        lines.push("Re-run with --explain to see whether a policy hid it.");
      }
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

/**
 * The static inventory (`AS-COVER-001…003`). The summary says "upper bound" in
 * so many words: a tsconfig's include globs are wider than what a bundle
 * reaches, so a capability in a component no route renders any more is in here.
 * That is dead code — a different finding, not a false positive — and the
 * reader has to be told which number they are holding.
 */
export function renderInventoryPlain(inventory: CapabilityInventory): string {
  const lines: string[] = [];
  const resolved = inventory.capabilities.filter((c) => c.resolution !== "unresolved");
  const unresolvedEntries = unresolved(inventory);
  const ids = authoredIds(inventory);

  lines.push(
    `${ids.size} authored (upper bound), ${resolved.length} call site${
      resolved.length === 1 ? "" : "s"
    } across ${inventory.filesAnalyzed} file${inventory.filesAnalyzed === 1 ? "" : "s"}`,
  );
  lines.push("domain: not analyzed — domain capabilities come from the oRPC router (OQ-1)");
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

  const byId = [...resolved].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  if (byId.length > 0) {
    lines.push("");
    for (const capability of byId) {
      const mark = capability.resolution === "static" ? " " : "~";
      lines.push(`  ${mark} ${capability.capabilityId}`);
      lines.push(`      ${capability.origin.file}:${capability.origin.line}  [${capability.kind}]`);
      if (capability.description) lines.push(`      ${capability.description}`);
      if (capability.note) lines.push(`      partial: ${capability.note}`);
    }
  }

  if (unresolvedEntries.length > 0) {
    lines.push("");
    lines.push(`unresolved  (${unresolvedEntries.length})`);
    for (const capability of unresolvedEntries) {
      lines.push(`  ? ${capability.origin.file}:${capability.origin.line}`);
      lines.push(`      ${capability.note ?? "the extractor could not read this call site"}`);
    }
    lines.push("");
    lines.push(
      `${unresolvedEntries.length} call site${
        unresolvedEntries.length === 1 ? "" : "s"
      } could not be resolved — fix them, or re-run with --allow-unresolved to accept the gap`,
    );
  }

  return lines.join("\n");
}

/**
 * The coverage report (`AS-COVER-004…005`). `unreached` is the finding this
 * command exists for; the other two buckets are reported rather than buried,
 * for the same reason the inventory reports what it could not parse.
 */
export function renderCoveragePlain(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.authored} authored (upper bound), ${report.reached} reached across ${
      report.scenarios.length
    } scenario${report.scenarios.length === 1 ? "" : "s"} (${report.scenarios.join(", ")})`,
  );

  if (report.unreached.length > 0) {
    lines.push("");
    lines.push(`unreached  (${report.unreached.length})`);
    for (const entry of report.unreached) {
      lines.push(`  ${entry.capabilityId}`);
      lines.push(`       ${entry.origin.file}:${entry.origin.line} — no scenario mounts it`);
    }
  }

  if (report.domainReached.length > 0) {
    lines.push("");
    lines.push(
      `domain (not analyzed)  (${report.domainReached.length}) — reached, and outside this inventory by design`,
    );
    for (const id of report.domainReached) lines.push(`  ${id}`);
  }

  if (report.undeclared.length > 0) {
    lines.push("");
    lines.push(`undeclared  (${report.undeclared.length})`);
    lines.push("  present at runtime with no static origin — a dynamic registration, or a gap here");
    for (const id of report.undeclared) lines.push(`  ${id}`);
  }

  if (report.unresolved.length > 0) {
    lines.push("");
    lines.push(`unresolved  (${report.unresolved.length})`);
    for (const capability of report.unresolved) {
      lines.push(`  ? ${capability.origin.file}:${capability.origin.line}`);
      lines.push(`      ${capability.note ?? "the extractor could not read this call site"}`);
    }
  }

  if (report.allowed.length > 0) {
    lines.push("");
    lines.push(
      `${report.allowed.length} unreached capabilit${
        report.allowed.length === 1 ? "y is" : "ies are"
      } allowlisted in ${report.allowlistPath}`,
    );
  }

  if (report.staleAllowlist.length > 0) {
    lines.push("");
    lines.push(`stale allowlist entries  (${report.staleAllowlist.length})`);
    lines.push("  these are reached now — delete them so the list cannot silently rot");
    for (const id of report.staleAllowlist) lines.push(`  ${id}`);
  }

  lines.push("");
  // Each bucket gets its own remedy. "Add a scenario, or delete the component"
  // is the right advice for an unreached capability and useless advice for a
  // call site the extractor could not read.
  const verdicts: string[] = [];
  if (report.unreached.length > 0) {
    verdicts.push(
      `surface coverage gap in ${report.unreached.length} capabilit${
        report.unreached.length === 1 ? "y" : "ies"
      } — add a scenario, or delete the component`,
    );
  }
  if (report.unresolved.length > 0) {
    verdicts.push(
      `${report.unresolved.length} call site${
        report.unresolved.length === 1 ? "" : "s"
      } could not be read, so this report is incomplete — fix them, or accept the gap knowingly`,
    );
  }
  if (report.staleAllowlist.length > 0) {
    verdicts.push(
      `${report.staleAllowlist.length} allowlist entr${
        report.staleAllowlist.length === 1 ? "y is" : "ies are"
      } stale — remove them so the list cannot silently rot`,
    );
  }
  if (verdicts.length === 0) {
    verdicts.push(
      report.allowed.length > 0
        ? "no new surface coverage gaps — the allowlist still holds the known ones"
        : "every authored capability is reached by a scenario",
    );
  }
  lines.push(...verdicts);
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
