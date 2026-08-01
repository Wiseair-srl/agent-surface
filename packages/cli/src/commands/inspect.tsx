import { createSurfaceRunner } from "../load.js";
import { buildView } from "../render/model.js";
import { renderSurfacePlain } from "../render/plain.js";
import { isPlain, loadInk, paint, transient, write } from "../output.js";
import type { CollectResult } from "../collect.js";

export interface InspectOptions {
  configPath: string;
  scenario?: string;
  scope?: string[];
  explain?: boolean;
  schemas?: boolean;
  json?: boolean;
  plain?: boolean;
}

function jsonFor(result: CollectResult, explain: boolean): Record<string, unknown> {
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
 * Renders the live surface. A bare `inspect` covers every scenario the config
 * defines, the same way bare `snapshot` and `check` do — a config lists the
 * contexts worth looking at, and picking one of them by `Object.keys` order
 * made the default silently depend on the order they happened to be written in.
 */
export async function runInspect(options: InspectOptions): Promise<number> {
  const runner = await createSurfaceRunner(options.configPath);
  // `null` when Ink cannot run here (React 18 host), which is a fallback to
  // plain text rather than a failed command — see loadInk().
  const ink = isPlain(options) ? null : await loadInk();
  try {
    const scenarios = options.scenario ? [options.scenario] : runner.scenarioNames;
    const collected: Array<Record<string, unknown>> = [];

    for (const [index, scenario] of scenarios.entries()) {
      const stop = ink
        ? await transient(<ink.Loading label={`mounting ${scenario}…`} />)
        : undefined;

      let result;
      try {
        result = await runner.collect({
          scenario,
          ...(options.scope ? { scope: options.scope } : {}),
        });
      } finally {
        stop?.();
      }

      // Each scenario is mounted and rendered before the next one is mounted,
      // so a slow config prints as it goes instead of after the last mount.
      // `--json` is the exception: one document, so it has to be complete.
      if (options.json) {
        collected.push(jsonFor(result, options.explain === true));
        continue;
      }

      const view = buildView(result, {
        ...(options.explain ? { explain: true } : {}),
        ...(options.schemas ? { schemas: true } : {}),
      });

      if (ink) await paint(<ink.Surface view={view} />);
      else write(index === 0 ? renderSurfacePlain(view) : `\n${renderSurfacePlain(view)}`);
    }

    if (options.json) write(JSON.stringify({ scenarios: collected }, null, 2));
    return 0;
  } finally {
    await runner.close();
  }
}
