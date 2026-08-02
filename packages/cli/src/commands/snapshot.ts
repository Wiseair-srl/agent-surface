import {
  joinCoverage,
  mountScenarios,
  readInventory,
  UsageError,
  type AnalysisOptions,
  type Depth,
} from "../analysis.js";
import { baselinePath, writeBaseline, writeScenarioManifest } from "../baseline.js";
import { scenarioBaseline } from "../report.js";
import { buildView, flatRows } from "../render/model.js";
import { createPresenter } from "../render/present.js";
import {
  coverageSections,
  displayPath,
  failureSection,
  mountingLabel,
  neverCallable,
  neverCallableSection,
  noVerdictSection,
  READING_SOURCE,
  runHeaderBlocks,
  scenarioStats,
  surfaceSummaryRows,
  trackReach,
  type CapabilityReach,
  type ReportPart,
} from "../render/summary.js";

export interface SnapshotOptions {
  configPath: string;
  depth: Depth;
  scenario?: string;
  scope?: string[];
  tsconfig?: string;
  baselineDir?: string;
  json?: boolean;
  plain?: boolean;
}

/**
 * Writes (or refreshes) the committed baseline `check` compares against.
 *
 * It prints the coverage verdict too. This is the command you run to *accept* a
 * change to the surface, which makes it the last moment before a reviewer sees
 * the diff — and accepting a projection while a capability sits behind a route
 * no scenario visits is exactly the state worth hearing about. It reports;
 * `check` is still the only thing that fails.
 *
 * Its report opens the way every other one does (`AS-CLI-013`): what the run
 * was pointed at, then what it wrote, then the verdict. It used to open with
 * bare `wrote …` lines and no header at all, which left the one command that
 * *changes committed files* as the only one that never said what it had been
 * pointed at while it did.
 */
export async function runSnapshot(options: SnapshotOptions): Promise<number> {
  if (options.depth === "static") {
    throw new UsageError(
      "snapshot --depth static has nothing to write — a baseline is a projection, and " +
        "at this depth nothing is mounted.",
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
  await present.wait(READING_SOURCE);

  const inventory = readInventory(analysis);
  let scenarios: string[] = [];
  let mountedCount = 0;
  const runtime = await mountScenarios(analysis, {
    onPlan: async (plan) => {
      scenarios = plan.scenarios;
      await present.emit({
        kind: "blocks",
        blocks: runHeaderBlocks("SURFACE SNAPSHOT", {
          configPath: options.configPath,
          depth: options.depth,
          ...(plan.scope ? { scope: plan.scope } : {}),
          scenarios: plan.scenarios,
          declaredScenarios: plan.declaredScenarios,
        }),
      });
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
  if (!runtime) throw new UsageError("snapshot needs a mount, and this depth performs none");

  const written: Array<{ cells: string[] }> = [];
  for (const result of runtime.results) {
    const path = baselinePath(runtime.baselineDir, result.scenario);
    writeBaseline(path, scenarioBaseline(result));
    written.push({ cells: [result.scenario, displayPath(path)] });
  }
  writeScenarioManifest(runtime.baselineDir, runtime.declaredScenarios);

  const reach = new Map<string, CapabilityReach>();
  for (const result of runtime.results) {
    trackReach(reach, flatRows(buildView(result)), result.scenario);
  }
  const coverage = joinCoverage(inventory, runtime, analysis);
  const stats = runtime.results.map(scenarioStats);
  const dark = neverCallable(reach);

  const parts: ReportPart[] = [
    { kind: "table", title: `WROTE  (${written.length})`, headers: ["SCENARIO", "FILE"], rows: written },
  ];

  // Over one scenario, "never callable" repeats that scenario's own table row
  // for row — see neverCallableSection().
  const sections = [
    ...(coverage ? coverageSections(coverage) : []),
    ...(dark.length > 0 && stats.length > 1 ? [neverCallableSection(dark)] : []),
  ];
  if (sections.length > 0) parts.push({ kind: "findings", sections });

  parts.push({
    kind: "blocks",
    blocks: [
      {
        title: "SURFACE SUMMARY",
        rows: surfaceSummaryRows({
          depth: options.depth,
          ...(coverage ? { coverage } : {}),
          scenarios: stats,
          failures: runtime.failures.length,
          reach,
        }),
      },
    ],
  });

  if (runtime.failures.length > 0) {
    // A baseline written for some scenarios and not others is a baseline that
    // will fail `check` for a reason that has nothing to do with the surface.
    parts.push({
      kind: "findings",
      stream: "err",
      sections: [
        failureSection(runtime.failures),
        ...(inventory ? [noVerdictSection(runtime.failures)] : []),
      ],
    });
  }

  await present.emit(...parts);
  return runtime.failures.length > 0 ? 2 : 0;
}
