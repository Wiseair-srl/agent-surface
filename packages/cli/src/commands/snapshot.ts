import { relative } from "node:path";
import { createSurfaceRunner } from "../load.js";
import { baselineDirFor, baselinePath, normalize, writeBaseline } from "../baseline.js";
import { write } from "../output.js";

export interface SnapshotOptions {
  configPath: string;
  scenario?: string;
  scope?: string[];
  baselineDir?: string;
}

/** Writes (or refreshes) the committed baseline `check` compares against. */
export async function runSnapshot(options: SnapshotOptions): Promise<number> {
  const runner = await createSurfaceRunner(options.configPath);
  try {
    const scenarios = options.scenario ? [options.scenario] : runner.scenarioNames;
    const dir = baselineDirFor(options.configPath, options.baselineDir ?? runner.config.baselineDir);

    for (const scenario of scenarios) {
      const result = await runner.collect({
        scenario,
        ...(options.scope ? { scope: options.scope } : {}),
      });
      const path = baselinePath(dir, scenario);
      writeBaseline(path, normalize(result.snapshot));
      write(`wrote ${relative(process.cwd(), path)}`);
    }
    return 0;
  } finally {
    await runner.close();
  }
}
