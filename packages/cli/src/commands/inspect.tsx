import {
  joinCoverage,
  mountScenarios,
  readInventory,
  type AnalysisOptions,
  type Depth,
} from "../analysis.js";
import { buildView } from "../render/model.js";
import {
  renderCatalogPlain,
  renderCoveragePlain,
  renderFailuresPlain,
  renderNoVerdictPlain,
  renderSurfacePlain,
} from "../render/plain.js";
import { isPlain, loadInk, paint, transient, write, writeError } from "../output.js";
import type { CollectResult } from "../collect.js";

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

function jsonForScenario(result: CollectResult, explain: boolean): Record<string, unknown> {
  return {
    scenario: result.scenario,
    ...(result.scope ? { scope: result.scope } : {}),
    snapshot: result.snapshot,
    // Unconditional, and unconditionally present even when empty (`AS-CLI-006`):
    // a consumer that has to distinguish "no rejections" from "this CLI predates
    // the field" cannot rely on an absent key.
    rejections: result.rejections,
    ...(explain ? { explanation: result.explanation } : {}),
  };
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
 * **Order is the design.** The catalog prints first because it is ready before
 * anything mounts; each scenario prints as it finishes, so a config with ten of
 * them is not ten mounts of blank terminal; the verdict prints last, because it
 * is the only part that needs every scenario to have finished — and because a
 * reader who stops at the bottom should stop on the finding.
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
  if (inventory && !options.json) {
    // At `--depth static` this listing is the output. At `--depth full` the
    // scenario tables below carry the same capabilities and the verdict names
    // the ones they miss, so only the summary line prints here.
    write(renderCatalogPlain(inventory, { standalone: options.depth === "static" }));
  }

  // `null` when Ink cannot run here (React 18 host), which is a fallback to
  // plain text rather than a failed command — see loadInk().
  const ink = isPlain(options) ? null : await loadInk();
  const scenarios: Array<Record<string, unknown>> = [];
  let printed = 0;

  const runtime = await mountScenarios(analysis, async (result) => {
    if (options.json) {
      scenarios.push(jsonForScenario(result, options.explain === true));
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

  const coverage = joinCoverage(inventory, runtime, analysis);

  if (options.json) {
    write(
      JSON.stringify(
        {
          // One shape whatever the depth, so a consumer never branches on how
          // the command was invoked. A half the depth did not compute is
          // `null`, which is a different statement from `[]` or `{}`.
          depth: options.depth,
          catalog: inventory ?? null,
          scenarios,
          failures: runtime?.failures ?? [],
          coverage: coverage ?? null,
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
