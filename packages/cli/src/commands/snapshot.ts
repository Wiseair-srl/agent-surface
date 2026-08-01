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
import { renderFailuresPlain, renderSurfaceSummaryPlain } from "../render/plain.js";
import {
  displayPath,
  scenarioStats,
  trackReach,
  type CapabilityReach,
} from "../render/summary.js";
import { write, writeError } from "../output.js";

export interface SnapshotOptions {
  configPath: string;
  depth: Depth;
  scenario?: string;
  scope?: string[];
  tsconfig?: string;
  baselineDir?: string;
}

/**
 * Writes (or refreshes) the committed baseline `check` compares against.
 *
 * It prints the coverage verdict too. This is the command you run to *accept* a
 * change to the surface, which makes it the last moment before a reviewer sees
 * the diff — and accepting a projection while a capability sits behind a route
 * no scenario visits is exactly the state worth hearing about. It reports;
 * `check` is still the only thing that fails.
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

  const inventory = readInventory(analysis);
  const runtime = await mountScenarios(analysis);
  if (!runtime) throw new UsageError("snapshot needs a mount, and this depth performs none");

  for (const result of runtime.results) {
    const path = baselinePath(runtime.baselineDir, result.scenario);
    writeBaseline(path, scenarioBaseline(result));
    write(`wrote ${displayPath(path)}`);
  }
  writeScenarioManifest(runtime.baselineDir, runtime.declaredScenarios);

  const reach = new Map<string, CapabilityReach>();
  for (const result of runtime.results) {
    trackReach(reach, flatRows(buildView(result)), result.scenario);
  }
  const coverage = joinCoverage(inventory, runtime, analysis);
  write("");
  write(
    renderSurfaceSummaryPlain({
      depth: options.depth,
      ...(coverage ? { coverage } : {}),
      scenarios: runtime.results.map(scenarioStats),
      failures: runtime.failures.length,
      reach,
    }),
  );

  if (runtime.failures.length > 0) {
    // A baseline written for some scenarios and not others is a baseline that
    // will fail `check` for a reason that has nothing to do with the surface.
    writeError(`\n${renderFailuresPlain(runtime.failures)}`);
    return 2;
  }
  return 0;
}
