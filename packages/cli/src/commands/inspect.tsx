import {
  joinCoverage,
  mountScenarios,
  readInventory,
  scopeCapabilityIds,
  scopeInventory,
  staticConfigScope,
  type AnalysisOptions,
  type Depth,
} from "../analysis.js";
import { buildView } from "../render/model.js";
import { authoredIds } from "../extract.js";
import {
  renderCatalogPlain,
  renderCoveragePlain,
  renderFailuresPlain,
  renderNoVerdictPlain,
  renderSurfacePlain,
} from "../render/plain.js";
import { isPlain, loadInk, paint, write, writeError } from "../output.js";
import {
  coverageReport,
  inventoryReport,
  scenarioReport,
  type ScenarioReport,
} from "../report.js";

export interface InspectOptions {
  configPath: string;
  depth: Depth;
  scenario?: string;
  scope?: string[];
  tsconfig?: string;
  baselineDir?: string;
  detail?: boolean;
  explain?: boolean;
  schemas?: boolean;
  json?: boolean;
  plain?: boolean;
}

/**
 * The whole surface: what this codebase authors, what a mount surfaces, and the
 * difference between them.
 *
 * It answers findings, it does not gate on them — exit `0` whatever it reports,
 * because `check` is the gate and a viewer that sometimes fails is a viewer
 * nobody puts in a pipeline. The exception is `2`, which is not a finding: the
 * command could not run at all.
 *
 * Each scenario prints as it finishes, so a config with ten of them is not ten
 * mounts of blank terminal. The normalized catalog summary and verdict follow
 * once effective config scope and the domain manifest are known.
 */
export async function runInspect(options: InspectOptions): Promise<number> {
  const analysis: AnalysisOptions = {
    configPath: options.configPath,
    depth: options.depth,
    ...(options.scenario ? { scenario: options.scenario } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
    ...(options.baselineDir ? { baselineDir: options.baselineDir } : {}),
  };

  // Policy chains and JSON Schemas are multi-line by nature, so asking for
  // either is asking for the view that can hold them.
  const detail = options.detail === true || options.explain === true || options.schemas === true;

  const inventory = readInventory(analysis);
  const initialInventory = scopeInventory(inventory, staticConfigScope(analysis));
  if (initialInventory && !options.json && options.depth === "static") {
    // At `--depth static` this listing is the output. At `--depth full` the
    // scenario tables below carry the same capabilities and the verdict names
    // the ones they miss, so only the summary line prints here.
    write(renderCatalogPlain(initialInventory, { standalone: true, detail }));
  }

  // `null` when Ink cannot run here (React 18 host), which is a fallback to
  // plain text rather than a failed command — see loadInk().
  const ink = isPlain(options) ? null : await loadInk();
  const scenarios: ScenarioReport[] = [];
  let printed = 0;

  const runtime = await mountScenarios(analysis, async (result) => {
    if (options.json) {
      scenarios.push(
        scenarioReport(result, {
          ...(options.explain ? { attribution: true } : {}),
          ...(options.schemas ? { schemas: true } : {}),
        }),
      );
      return;
    }
    const view = buildView(result, {
      ...(options.explain ? { explain: true } : {}),
      ...(options.schemas ? { schemas: true } : {}),
    });
    if (ink) await paint(<ink.Surface view={view} detail={detail} />);
    else {
      const rendered = renderSurfacePlain(view, { detail });
      write(printed === 0 && !inventory ? rendered : `\n${rendered}`);
    }
    printed += 1;
  });

  const effectiveScope = options.scope ?? runtime?.scope ?? staticConfigScope(analysis);
  const reportInventory = scopeInventory(inventory, effectiveScope);
  const reportDomain = runtime?.domainManifestConfigured
    ? scopeCapabilityIds(runtime.domainCapabilities, effectiveScope)
    : undefined;
  const coverage = joinCoverage(inventory, runtime, analysis);
  if (reportInventory && !options.json && options.depth === "full") {
    write(
      `${printed > 0 ? "\n" : ""}${renderCatalogPlain(reportInventory, {
        ...(coverage && runtime?.domainManifestConfigured
          ? { domainCapabilities: coverage.authored - authoredIds(reportInventory).size }
          : {}),
      })}`,
    );
  }

  if (options.json) {
    write(
      JSON.stringify(
        {
          // One shape whatever the depth, so a consumer never branches on how
          // the command was invoked. A half the depth did not compute is
          // `null`, which is a different statement from `[]` or `{}`.
          depth: options.depth,
          catalog: inventoryReport(reportInventory, reportDomain),
          scenarios,
          failures: runtime?.failures ?? [],
          coverage: coverageReport(coverage),
        },
        null,
        2,
      ),
    );
    return runtime && runtime.failures.length > 0 ? 2 : 0;
  }

  if (runtime && runtime.failures.length > 0) {
    writeError(`\n${renderFailuresPlain(runtime.failures)}`);
  }
  if (coverage) {
    write("");
    write(renderCoveragePlain(coverage));
  } else if (inventory && runtime && runtime.failures.length > 0) {
    writeError(`\n${renderNoVerdictPlain(runtime.failures)}`);
  }

  // A scenario that would not mount is not a finding about the surface, it is
  // the command failing to observe one. `2` — the same code a usage error gets,
  // because CI has to tell both apart from "the surface changed".
  return runtime && runtime.failures.length > 0 ? 2 : 0;
}
