import { relative } from "node:path";
import {
  UsageError,
  joinCoverage,
  mountScenarios,
  readInventory,
  type AnalysisOptions,
  type Depth,
} from "../analysis.js";
import { annotate, baselinePath, diff, normalize, readBaseline, type DiffEntry } from "../baseline.js";
import { coverageExitCode } from "../coverage.js";
import {
  renderCoveragePlain,
  renderDriftPlain,
  renderFailuresPlain,
  renderNoVerdictPlain,
} from "../render/plain.js";
import { write, writeError } from "../output.js";

export interface CheckOptions {
  configPath: string;
  depth: Depth;
  scenario?: string;
  scope?: string[];
  tsconfig?: string;
  baselineDir?: string;
  allowUnresolved?: boolean;
  json?: boolean;
  plain?: boolean;
}

interface ScenarioDrift {
  scenario: string;
  missingBaseline?: boolean;
  entries: DiffEntry[];
}

/**
 * The gate. The only command in this package that fails on a finding, which is
 * why every finding has to reach it.
 *
 * It used to fail on exactly one class — the projection drifting from its
 * baseline — and print a line telling you that capabilities no scenario mounts
 * were a different command's question. A gate that names the check it is not
 * performing is a gate with a hole in it, and in CI the hole was silent: a
 * whole unreached route sat behind a green tick.
 *
 * So it now fails on four:
 *
 * - **drift** — the surface changed against its committed baseline;
 * - **a missing baseline** — nothing to compare, which is not the same as a match;
 * - **an unreached capability** — authored, and no scenario mounts it;
 * - **an unread call site** — the catalog is incomplete, so the third check
 *   above is computed over a denominator that is only a floor.
 *
 * `.agent-surface/coverage-allow.json` ratchets the third; `--allow-unresolved`
 * accepts the fourth. Both are deliberate, committed decisions rather than
 * flags that quietly widen the gate.
 *
 * Output is always plain, with no rendering framework in its path at all: this
 * is a report that gets pasted into a pull request and read out of a CI log,
 * and neither of those is a terminal.
 */
export async function runCheck(options: CheckOptions): Promise<number> {
  if (options.depth === "static") {
    throw new UsageError(
      "check --depth static has nothing to compare — a baseline is a projection, and " +
        "at this depth nothing is mounted. Use --depth runtime for drift alone, or full for both.",
    );
  }

  const analysis: AnalysisOptions = {
    configPath: options.configPath,
    depth: options.depth,
    ...(options.scenario ? { scenario: options.scenario } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
    ...(options.baselineDir ? { baselineDir: options.baselineDir } : {}),
  };

  const inventory = readInventory(analysis);
  // No streaming here, unlike `inspect`. A report is read top-down and has to
  // lead with its findings, which means every finding has to exist first.
  const runtime = await mountScenarios(analysis);
  if (!runtime) throw new UsageError("check needs a mount, and this depth performs none");

  const drifted: ScenarioDrift[] = [];
  for (const result of runtime.results) {
    const path = baselinePath(runtime.baselineDir, result.scenario);
    const expected = readBaseline(path);
    if (expected === undefined) {
      drifted.push({ scenario: result.scenario, missingBaseline: true, entries: [] });
      continue;
    }
    const actual = normalize(result.snapshot);
    const entries = annotate(diff(expected, actual), actual, expected);
    if (entries.length > 0) drifted.push({ scenario: result.scenario, entries });
  }

  const coverage = joinCoverage(inventory, runtime, analysis);
  const coverageFailed =
    coverage !== undefined &&
    coverageExitCode(coverage, { allowUnresolved: options.allowUnresolved === true }) !== 0;
  const couldNotRun = runtime.failures.length > 0;
  const ok = drifted.length === 0 && !coverageFailed && !couldNotRun;

  if (options.json) {
    write(
      JSON.stringify(
        { ok, drifted, failures: runtime.failures, coverage: coverage ?? null },
        null,
        2,
      ),
    );
    return couldNotRun ? 2 : ok ? 0 : 1;
  }

  // The gap leads, because it is the finding this command could not previously
  // make at all. Drift follows, because it is the one it always could.
  if (coverage) {
    const rendered = renderCoveragePlain(coverage);
    if (coverageFailed) writeError(rendered);
    else write(rendered);
  }

  // "No baseline" is not drift, and filing it under a heading that says the
  // surface changed would be a claim about a comparison that never happened.
  const missing = drifted.filter((entry) => entry.missingBaseline);
  const changed = drifted.filter((entry) => !entry.missingBaseline);

  if (missing.length > 0) {
    writeError(
      [
        `${coverage ? "\n" : ""}NO BASELINE — nothing to compare against, which is not the same as a match  (${missing.length})`,
        ...missing.map(
          (entry) =>
            `  ${entry.scenario}: ${relative(
              process.cwd(),
              baselinePath(runtime.baselineDir, entry.scenario),
            )} does not exist — run \`agent-surface snapshot\` and commit it`,
        ),
      ].join("\n"),
    );
  }

  if (changed.length > 0) {
    writeError(
      [
        `${coverage || missing.length > 0 ? "\n" : ""}DRIFT — the surface changed against its baseline  (${changed.length})`,
        ...changed.map((entry) => renderDriftPlain(entry.scenario, entry.entries)),
        "",
        `surface drift in ${changed.length} scenario${
          changed.length === 1 ? "" : "s"
        } — review the change, then \`agent-surface snapshot\` to accept it`,
      ].join("\n"),
    );
  }

  if (couldNotRun) {
    writeError(`\n${renderFailuresPlain(runtime.failures)}`);
    if (inventory) writeError(`\n${renderNoVerdictPlain(runtime.failures)}`);
    return 2;
  }

  if (ok) {
    if (coverage) write("");
    // Naming them is the point (`AS-CLI-007`). This used to have to add that it
    // was a statement about these scenarios only, and point at another command
    // for the rest; at `--depth full` there is no rest, so the caveat is gone
    // along with the command it pointed at.
    write(`surface matches the baseline in ${runtime.scenarios.join(", ")}`);
    if (!coverage) {
      write(
        "that is a statement about these scenarios only — re-run at --depth full to find " +
          "capabilities no scenario mounts",
      );
    }
    return 0;
  }
  return 1;
}
