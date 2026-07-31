import { createSurfaceRunner } from "../load.js";
import { buildView } from "../render/model.js";
import { renderSurfacePlain } from "../render/plain.js";
import { isPlain, loadInk, paint, transient, write } from "../output.js";

export interface InspectOptions {
  configPath: string;
  scenario?: string;
  scope?: string[];
  explain?: boolean;
  schemas?: boolean;
  json?: boolean;
  plain?: boolean;
}

export async function runInspect(options: InspectOptions): Promise<number> {
  const runner = await createSurfaceRunner(options.configPath);
  // `null` when Ink cannot run here (React 18 host), which is a fallback to
  // plain text rather than a failed command — see loadInk().
  const ink = isPlain(options) ? null : await loadInk();
  try {
    const scenario = options.scenario ?? runner.scenarioNames[0]!;
    const stop = ink ? await transient(<ink.Loading label={`mounting ${scenario}…`} />) : undefined;

    let result;
    try {
      result = await runner.collect({
        scenario,
        ...(options.scope ? { scope: options.scope } : {}),
      });
    } finally {
      stop?.();
    }

    if (options.json) {
      write(
        JSON.stringify(
          {
            scenario: result.scenario,
            snapshot: result.snapshot,
            ...(options.explain ? { explanation: result.explanation } : {}),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const view = buildView(result, {
      ...(options.explain ? { explain: true } : {}),
      ...(options.schemas ? { schemas: true } : {}),
    });

    if (ink) await paint(<ink.Surface view={view} />);
    else write(renderSurfacePlain(view));
    return 0;
  } finally {
    await runner.close();
  }
}
