import { existsSync, readdirSync } from "node:fs";
import {
  UsageError,
  joinCoverage,
  mountScenarios,
  readInventory,
  type AnalysisOptions,
  type Depth,
} from "../analysis.js";
import {
  annotate,
  baselinePath,
  diff,
  readBaseline,
  readScenarioManifest,
  SCENARIO_MANIFEST_FILE,
  type DiffEntry,
} from "../baseline.js";
import { ALLOWLIST_FILE, coverageExitCode, UNREAD_ALLOWLIST_FILE } from "../coverage.js";
import { renderDriftPlain } from "../render/plain.js";
import { createPresenter } from "../render/present.js";
import {
  checkOverviewParts,
  coverageSections,
  displayPath,
  failureSection,
  mountingLabel,
  noVerdictSection,
  READING_SOURCE,
  scenarioStats,
  type FindingSection,
  type ReportPart,
  type ScenarioStats,
} from "../render/summary.js";
import { write } from "../output.js";
import { coverageReport, scenarioBaseline } from "../report.js";

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
  detail?: boolean;
}

interface ScenarioDrift {
  scenario: string;
  missingBaseline?: boolean;
  entries: DiffEntry[];
}

interface RejectedScenario {
  scenario: string;
  rejections: Array<{ componentType: string; instanceId: string; reason: string }>;
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
 * So it now fails on every incomplete or changed report:
 *
 * - **drift** — the surface changed against its committed baseline;
 * - **a missing baseline** — nothing to compare, which is not the same as a match;
 * - **an unreached capability** — authored, and no scenario mounts it;
 * - **an unread call site** — the catalog is incomplete, so the third check
 *   above is computed over a denominator that is only a floor;
 * - **a rejected registration** — authored surface was refused;
 * - **scenario drift** — config, manifest and baseline files disagree.
 *
 * `.agent-surface/coverage-allow.json` ratchets the third; `--allow-unresolved`
 * accepts the fourth. Both are deliberate, committed decisions rather than
 * flags that quietly widen the gate.
 *
 * The report is read top-down: the verdict, what it was computed over, one row
 * per class of finding whether or not it fired, one row per scenario, then the
 * findings themselves and the commands that clear them — the same shapes, in
 * the same grid, that `inspect` uses for the same things. Its output is a
 * report pasted into a pull request and read out of a CI log, and neither of
 * those is a terminal — so neither of those gets a terminal UI: piped, `CI` and
 * `NO_COLOR` all render plain text, and that is decided by the presenter, once,
 * rather than by this command declining to have a renderer at all.
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

  const present = await createPresenter(options);
  if (!options.json) await present.wait(READING_SOURCE);

  const inventory = readInventory(analysis);
  // No streaming here, unlike `inspect`. A report is read top-down and has to
  // lead with its findings, which means every finding has to exist first — so
  // the terminal is told what it is waiting for instead, in the same words and
  // with the same spinner `inspect` uses for the same wait.
  let scenarios: string[] = [];
  let mountedCount = 0;
  const runtime = await mountScenarios(analysis, {
    onPlan: async (plan) => {
      scenarios = plan.scenarios;
      if (scenarios.length > 0) await present.wait(mountingLabel(scenarios, 0));
    },
    onEach: async () => {
      mountedCount += 1;
      if (mountedCount < scenarios.length) {
        await present.wait(mountingLabel(scenarios, mountedCount));
      }
    },
  });
  present.settle();
  if (!runtime) throw new UsageError("check needs a mount, and this depth performs none");

  const drifted: ScenarioDrift[] = [];
  for (const result of runtime.results) {
    const path = baselinePath(runtime.baselineDir, result.scenario);
    const expected = readBaseline(path);
    if (expected === undefined) {
      drifted.push({ scenario: result.scenario, missingBaseline: true, entries: [] });
      continue;
    }
    const actual = scenarioBaseline(result);
    const entries = annotate(diff(expected, actual), actual, expected);
    if (entries.length > 0) drifted.push({ scenario: result.scenario, entries });
  }

  const committedScenarios = readScenarioManifest(runtime.baselineDir);
  const declared = [...runtime.declaredScenarios].sort();
  const scenarioManifestMismatch =
    committedScenarios === undefined ||
    JSON.stringify(committedScenarios) !== JSON.stringify(declared);
  const reserved = new Set([SCENARIO_MANIFEST_FILE, ALLOWLIST_FILE, UNREAD_ALLOWLIST_FILE]);
  const staleBaselineFiles = (
    existsSync(runtime.baselineDir) ? readdirSync(runtime.baselineDir, { withFileTypes: true }) : []
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !reserved.has(entry.name))
    .map((entry) => entry.name.slice(0, -5))
    .filter((scenario) => !runtime.declaredScenarios.includes(scenario))
    .sort();

  const rejected: RejectedScenario[] = runtime.results
    .filter((result) => result.rejections.length > 0)
    .map((result) => ({ scenario: result.scenario, rejections: result.rejections }));

  const coverage = joinCoverage(inventory, runtime, analysis);
  const coverageFailed =
    coverage !== undefined &&
    coverageExitCode(coverage, { allowUnresolved: options.allowUnresolved === true }) !== 0;
  const couldNotRun = runtime.failures.length > 0;
  const ok =
    drifted.length === 0 &&
    !coverageFailed &&
    !couldNotRun &&
    rejected.length === 0 &&
    !scenarioManifestMismatch &&
    staleBaselineFiles.length === 0;

  if (options.json) {
    write(
      JSON.stringify(
        {
          ok,
          drifted,
          failures: runtime.failures,
          rejected,
          scenarioManifest: {
            expected: declared,
            committed: committedScenarios ?? null,
            staleBaselines: staleBaselineFiles,
          },
          coverage: coverageReport(coverage),
        },
        null,
        2,
      ),
    );
    return couldNotRun ? 2 : ok ? 0 : 1;
  }

  // "No baseline" is not drift, and filing it under a heading that says the
  // surface changed would be a claim about a comparison that never happened.
  const missing = drifted.filter((entry) => entry.missingBaseline);
  const changed = drifted.filter((entry) => !entry.missingBaseline);

  const baselineOf = (scenario: string): string => {
    const entry = drifted.find((candidate) => candidate.scenario === scenario);
    if (!entry) return "current";
    if (entry.missingBaseline) return "missing";
    return `drift (${entry.entries.length})`;
  };
  // One row per scenario the run attempted, in config order — including the
  // ones that threw, which otherwise appear only at the bottom of the report.
  const stats: ScenarioStats[] = runtime.scenarios.map((scenario) => {
    const result = runtime.results.find((candidate) => candidate.scenario === scenario);
    if (result) return { ...scenarioStats(result), baseline: baselineOf(scenario) };
    const failure = runtime.failures.find((entry) => entry.scenario === scenario);
    return {
      scenario,
      callable: 0,
      disabled: 0,
      hidden: 0,
      rejected: 0,
      failed: true,
      ...(failure?.message ? { failure: failure.message } : {}),
    };
  });

  // A failing report goes to stderr in full. The verdict is the part a reader
  // has to see, and a gate whose red is on the stream nobody captured is a gate
  // that reads as green.
  const stream = ok ? undefined : ("err" as const);
  const parts: ReportPart[] = checkOverviewParts({
    status: couldNotRun ? "ERROR" : ok ? "PASS" : "FAIL",
    ...(coverage ? { coverage } : {}),
    unresolvedAllowed: options.allowUnresolved === true,
    baselineCurrent: Math.max(0, runtime.results.length - drifted.length),
    baselineTotal: runtime.scenarios.length,
    scenarioManifestOk: !scenarioManifestMismatch && staleBaselineFiles.length === 0,
    rejected: rejected.reduce((sum, entry) => sum + entry.rejections.length, 0),
    mountFailures: runtime.failures.length,
    context: {
      configPath: options.configPath,
      depth: options.depth,
      ...(runtime.scope ? { scope: runtime.scope } : {}),
    },
    stats,
  }).map((part) => ({ ...part, ...(stream ? { stream } : {}) }));

  // The gap leads, because it is the finding this command could not previously
  // make at all. Drift follows, because it is the one it always could.
  if (coverage) {
    const gaps = coverageSections(coverage, {
      compact: true,
      ...(options.detail ? { detail: true } : {}),
    });
    if (gaps.length > 0) {
      parts.push({
        kind: "findings",
        sections: gaps,
        ...(coverageFailed ? { stream: "err" as const } : {}),
      });
    }
  }

  const sections: FindingSection[] = [];
  const steps: string[] = [];
  if (coverage && coverage.unreached.length > 0) {
    steps.push(
      `mount the ${coverage.unreached.length} unreached capabilit${
        coverage.unreached.length === 1 ? "y" : "ies"
      } from a scenario, or record the decision in ${displayPath(coverage.allowlistPath)}`,
    );
  }
  if (coverage && coverage.unresolved.length > 0 && options.allowUnresolved !== true) {
    steps.push(
      `make the ${coverage.unresolved.length} unread call site${
        coverage.unresolved.length === 1 ? "" : "s"
      } readable, or paste each printed key into ${displayPath(coverage.unreadAllowlistPath)}`,
    );
  }

  if (rejected.length > 0) {
    const total = rejected.reduce((sum, entry) => sum + entry.rejections.length, 0);
    sections.push({
      title: "REJECTED REGISTRATIONS",
      gloss: "the runtime refused authored surface during the mount",
      count: total,
      lines: rejected.flatMap((entry) =>
        entry.rejections.map(
          (rejection) =>
            `${entry.scenario}: ${rejection.componentType}@${rejection.instanceId} (${rejection.reason})`,
        ),
      ),
      hint:
        "a dead handle registers nothing — give the second registration its own instanceId, " +
        "or remove the duplicated component type",
    });
    steps.push(
      `resolve ${total} rejected registration${total === 1 ? "" : "s"} — the capabilities ` +
        "behind them reach no agent",
    );
  }

  if (scenarioManifestMismatch || staleBaselineFiles.length > 0) {
    sections.push({
      title: "SCENARIO DRIFT",
      gloss: "the committed baselines do not match the config",
      count: 0,
      lines: [
        `config:   ${declared.join(", ")}`,
        `manifest: ${committedScenarios?.join(", ") ?? "missing"}`,
        ...(staleBaselineFiles.length > 0 ? [`stale:    ${staleBaselineFiles.join(", ")}`] : []),
      ],
      hint:
        "run `agent-surface snapshot`, commit the manifest, and delete any baseline for a " +
        "scenario the config no longer declares",
    });
  }

  if (missing.length > 0) {
    sections.push({
      title: "NO BASELINE",
      gloss: "nothing to compare against, which is not the same as a match",
      count: missing.length,
      lines: missing.map(
        (entry) =>
          `${entry.scenario}: ${displayPath(
            baselinePath(runtime.baselineDir, entry.scenario),
          )} does not exist`,
      ),
      hint: "run `agent-surface snapshot` and commit the files it writes",
    });
  }

  if (changed.length > 0) {
    sections.push({
      title: "DRIFT",
      gloss: "the surface changed against its baseline",
      count: changed.length,
      lines: changed.flatMap((entry) => renderDriftPlain(entry.scenario, entry.entries)),
      hint:
        "review the change, then `agent-surface snapshot` to accept it" +
        (runtime.scope
          ? ". A scope filters the projection while baselines are written from whatever " +
            "scope wrote them, so re-check without --scope before believing this one"
          : ""),
    });
  }

  const baselinesStale =
    missing.length > 0 ||
    changed.length > 0 ||
    scenarioManifestMismatch ||
    staleBaselineFiles.length > 0;
  if (baselinesStale) {
    steps.push(
      "`agent-surface snapshot`, then commit .agent-surface/ — this accepts the surface " +
        "above as reviewed",
    );
  }

  if (sections.length > 0) parts.push({ kind: "findings", stream: "err", sections });

  if (couldNotRun) {
    parts.push({
      kind: "findings",
      stream: "err",
      sections: [
        failureSection(runtime.failures),
        ...(inventory ? [noVerdictSection(runtime.failures)] : []),
      ],
    });
    // First, and above every other remedy: nothing else in this report can be
    // trusted while a scenario the config declares never ran.
    steps.unshift(
      `fix the mount for ${runtime.failures
        .map((failure) => failure.scenario)
        .join(", ")} — every count above is missing whatever ${
        runtime.failures.length === 1 ? "it" : "they"
      } would have surfaced`,
    );
  }

  // Last, and only when something failed: the tail of a CI log is what a reader
  // sees first, and a list of findings without the commands that clear them
  // leaves the reader to derive those from six different sections.
  if (!ok && steps.length > 0) {
    parts.push({ kind: "steps", stream: "err", title: "NEXT STEPS", steps });
  }

  await present.emit(...parts);
  return couldNotRun ? 2 : ok ? 0 : 1;
}
