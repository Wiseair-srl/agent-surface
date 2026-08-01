import {
  joinCoverage,
  mountScenarios,
  readInventory,
  scopeCapabilityIds,
  scopeInventory,
  staticConfigScope,
  type AnalysisOptions,
  type Depth,
  type RuntimePlan,
} from "../analysis.js";
import { buildView, flatRows, type SurfaceView } from "../render/model.js";
import {
  catalogRows,
  coverageSections,
  neverCallable,
  neverCallableSection,
  runHeaderBlocks,
  scenarioStats,
  scenarioTable,
  surfaceSummaryRows,
  trackReach,
  type CapabilityReach,
  type FindingSection,
  type ReportBlock,
  type ScenarioStats,
} from "../render/summary.js";
import {
  renderCatalogDetailPlain,
  renderFailuresPlain,
  renderNoVerdictPlain,
  renderReportPlain,
  renderSectionsPlain,
  renderSurfacePlain,
  renderTablePlain,
} from "../render/plain.js";
import { isPlain, loadInk, paint, transient, write, writeError } from "../output.js";
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
 * The report is read top-down, so it is written top-down: **summaries first,
 * details after.**
 *
 * 1. **The run** — the config, the depth, the scope, the scenarios. All of it is
 *    known before the first mount, and the mounts are the slow half, so it
 *    prints immediately rather than making a reader wait to learn what is being
 *    measured.
 * 2. **The summary** — reach, what is callable, what the surface can do, the
 *    verdict. The answer, before anything it was derived from.
 * 3. **One row per scenario**, for a config with more than one.
 * 4. **The findings** — unreached, never callable, unread call sites — each with
 *    what to do about it.
 * 5. **The details** — the static catalog, then each scenario's own table.
 *
 * That order costs the streaming this command used to do: the summary is a
 * statement about every scenario, so it cannot be written until every scenario
 * has mounted. A terminal is told what it is waiting for instead — the header
 * is already on screen and a spinner names the scenario being mounted — and
 * `check`, whose output has always been a report, works the same way.
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

  // `null` when Ink cannot run here (React 18 host), which is a fallback to
  // plain text rather than a failed command — see loadInk().
  const ink = isPlain(options) ? null : await loadInk();
  // Ink separates blocks with its own margin; plain text has to be asked.
  const say = async (blocks: ReportBlock[], lead = true): Promise<void> => {
    if (ink) await paint(<ink.Report blocks={blocks} />);
    else write(`${lead ? "\n" : ""}${renderReportPlain(blocks)}`);
  };

  // The TypeScript program is read synchronously and the app loads after it;
  // together that is seconds on a real repository, and a terminal that shows
  // nothing for them looks wedged. Nothing transient is ever written in plain
  // mode: `AS-CLI-003` wants byte-stable output, and a spinner is neither.
  let stopWaiting = ink ? await transient(<ink.Loading label="reading the source" />) : undefined;
  const settle = (): void => {
    stopWaiting?.();
    stopWaiting = undefined;
  };
  const waitFor = async (label: string): Promise<void> => {
    settle();
    if (ink) stopWaiting = await transient(<ink.Loading label={label} />);
  };
  /** `mounting anonymous (2 of 2)` — which one, and how much is left. */
  const mounting = (list: string[], index: number): string =>
    `mounting ${list[index]}${list.length > 1 ? ` (${index + 1} of ${list.length})` : ""}`;

  const inventory = readInventory(analysis);
  const scenarios: ScenarioReport[] = [];
  const stats: ScenarioStats[] = [];
  const views: SurfaceView[] = [];
  const reach = new Map<string, CapabilityReach>();
  let plan: RuntimePlan | undefined;

  const scope = (): string[] | undefined => plan?.scope ?? staticConfigScope(analysis);
  const scopedInventory = (): ReturnType<typeof scopeInventory> =>
    scopeInventory(inventory, scope());
  const domainCount = (): number | undefined =>
    plan?.domainManifestConfigured
      ? scopeCapabilityIds(plan.domainCapabilities, scope()).length
      : undefined;

  const header = async (): Promise<void> => {
    settle();
    if (options.json) return;
    const active = scope();
    await say(
      // At `--depth static` the catalog *is* the answer, so it opens the report
      // beside the run it came from. At every other depth it is a detail behind
      // the summary, and prints down there instead.
      runHeaderBlocks(
        "SURFACE INSPECT",
        {
          configPath: options.configPath,
          depth: options.depth,
          ...(active ? { scope: active } : {}),
          ...(plan ? { scenarios: plan.scenarios, declaredScenarios: plan.declaredScenarios } : {}),
        },
        plan ? undefined : scopedInventory(),
        domainCount(),
      ),
      false,
    );
    if (!plan && inventory) {
      const catalog = renderCatalogDetailPlain(scopedInventory() ?? inventory, {
        ...(detail ? { detail: true } : {}),
      });
      if (catalog) write(`\n${catalog}`);
    }
  };

  const runtime = await mountScenarios(analysis, {
    onPlan: async (current) => {
      plan = current;
      await header();
      if (current.scenarios.length > 0) await waitFor(mounting(current.scenarios, 0));
    },
    onEach: async (result) => {
      const view = buildView(result, {
        ...(options.explain ? { explain: true } : {}),
        ...(options.schemas ? { schemas: true } : {}),
      });
      trackReach(reach, flatRows(view), result.scenario);
      stats.push(scenarioStats(result));
      if (options.json) {
        scenarios.push(
          scenarioReport(result, {
            ...(options.explain ? { attribution: true } : {}),
            ...(options.schemas ? { schemas: true } : {}),
          }),
        );
      } else {
        views.push(view);
      }
      // Named, and only while there is one left: a spinner announcing work
      // nobody is doing has to be read twice before it can be dismissed.
      if (plan && stats.length < plan.scenarios.length) {
        await waitFor(mounting(plan.scenarios, stats.length));
      }
    },
  });
  settle();
  if (!runtime) await header();

  const effectiveScope = options.scope ?? runtime?.scope ?? staticConfigScope(analysis);
  const reportInventory = scopeInventory(inventory, effectiveScope);
  const reportDomain = runtime?.domainManifestConfigured
    ? scopeCapabilityIds(runtime.domainCapabilities, effectiveScope)
    : undefined;
  const coverage = joinCoverage(inventory, runtime, analysis);
  const dark = neverCallable(reach);

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
          // Mounted, and callable in no scenario — a gap the coverage join
          // cannot see, because every one of these *was* reached.
          neverCallable: dark.map((entry) => ({
            capabilityId: entry.capabilityId,
            outcome: entry.best,
            ...(entry.note ? { reason: entry.note } : {}),
            scenarios: entry.scenarios,
          })),
        },
        null,
        2,
      ),
    );
    return runtime && runtime.failures.length > 0 ? 2 : 0;
  }

  if (!runtime) return 0;

  // A scenario that threw is not in `stats`, and every count below is missing
  // whatever it held — so it takes a row of its own rather than appearing only
  // at the bottom of the report.
  for (const failure of runtime.failures) {
    stats.push({
      scenario: failure.scenario,
      callable: 0,
      disabled: 0,
      hidden: 0,
      rejected: 0,
      failed: true,
      failure: failure.message,
    });
  }
  stats.sort((a, b) => runtime.scenarios.indexOf(a.scenario) - runtime.scenarios.indexOf(b.scenario));
  const mounted = stats.filter((entry) => !entry.failed).length;

  await say([
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
  ]);

  // One row per scenario, so a config with more than one can be compared in a
  // single place rather than by scrolling through its tables.
  if (stats.length > 1) {
    const table = scenarioTable(stats);
    const title = `SCENARIOS  (${stats.length})`;
    if (ink) await paint(<ink.Table title={title} headers={table.headers} rows={table.rows} />);
    else write(`\n${title}\n${renderTablePlain(table.headers, table.rows)}`);
  }

  if (runtime.failures.length > 0) {
    writeError(`\n${renderFailuresPlain(runtime.failures)}`);
    if (inventory) writeError(`\n${renderNoVerdictPlain(runtime.failures)}`);
  }

  // Over one scenario, "never callable" repeats that scenario's own table row
  // for row. It is a finding only once there is more than one scenario for a
  // capability to have been callable in.
  const sections: FindingSection[] = [
    ...(coverage ? coverageSections(coverage) : []),
    ...(dark.length > 0 && mounted > 1 ? [neverCallableSection(dark)] : []),
  ];
  if (sections.length > 0) {
    if (ink) await paint(<ink.Findings sections={sections} />);
    else write(`\n${renderSectionsPlain(sections)}`);
  }

  // Details. The catalog first, because the scenario tables below are what it
  // is the denominator of.
  const catalog = scopeInventory(inventory, effectiveScope);
  if (catalog) {
    await say([
      {
        title: "STATIC CATALOG",
        rows: catalogRows(catalog, {
          ...(domainCount() === undefined ? {} : { domainCapabilities: domainCount()! }),
          mounted: true,
        }),
      },
    ]);
  }

  for (const view of views) {
    if (ink) await paint(<ink.Surface view={view} detail={detail} />);
    else write(`\n${renderSurfacePlain(view, { detail })}`);
  }

  // A scenario that would not mount is not a finding about the surface, it is
  // the command failing to observe one. `2` — the same code a usage error gets,
  // because CI has to tell both apart from "the surface changed".
  return runtime.failures.length > 0 ? 2 : 0;
}
