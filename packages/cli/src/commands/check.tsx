import { relative } from "node:path";
import { createSurfaceRunner } from "../load.js";
import {
  annotate,
  baselineDirFor,
  baselinePath,
  diff,
  normalize,
  readBaseline,
  type DiffEntry,
} from "../baseline.js";
import { renderDiffPlain } from "../render/plain.js";
import { isPlain, loadInk, paint, write, writeError } from "../output.js";

export interface CheckOptions {
  configPath: string;
  scenario?: string;
  scope?: string[];
  baselineDir?: string;
  json?: boolean;
  plain?: boolean;
}

interface ScenarioDrift {
  scenario: string;
  missingBaseline?: boolean;
  entries: DiffEntry[];
}

/**
 * Compares every scenario against its committed baseline. Exit code is the
 * point: 0 when the surface is what the repo says it is, 1 when it drifted —
 * so CI fails on an unreviewed change to what agents can see.
 */
export async function runCheck(options: CheckOptions): Promise<number> {
  const runner = await createSurfaceRunner(options.configPath);
  try {
    const scenarios = options.scenario ? [options.scenario] : runner.scenarioNames;
    const dir = baselineDirFor(options.configPath, options.baselineDir ?? runner.config.baselineDir);
    const drifted: ScenarioDrift[] = [];

    for (const scenario of scenarios) {
      const result = await runner.collect({
        scenario,
        ...(options.scope ? { scope: options.scope } : {}),
      });
      const path = baselinePath(dir, scenario);
      const expected = readBaseline(path);

      if (expected === undefined) {
        drifted.push({ scenario, missingBaseline: true, entries: [] });
        continue;
      }
      const actual = normalize(result.snapshot);
      const entries = annotate(diff(expected, actual), actual, expected);
      if (entries.length > 0) drifted.push({ scenario, entries });
    }

    if (options.json) {
      write(JSON.stringify({ ok: drifted.length === 0, drifted }, null, 2));
      return drifted.length === 0 ? 0 : 1;
    }

    if (drifted.length === 0) {
      write(`surface matches the baseline (${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"})`);
      return 0;
    }

    const ink = isPlain(options) ? null : await loadInk();
    for (const entry of drifted) {
      if (entry.missingBaseline) {
        writeError(
          `${entry.scenario}: no baseline at ${relative(
            process.cwd(),
            baselinePath(dir, entry.scenario),
          )} — run \`agent-surface snapshot\` and commit it`,
        );
        continue;
      }
      if (ink) await paint(<ink.Drift scenario={entry.scenario} entries={entry.entries} />);
      else write(renderDiffPlain(entry.scenario, entry.entries));
    }
    writeError(
      `\nsurface drift in ${drifted.length} scenario${drifted.length === 1 ? "" : "s"} — review the change, then \`agent-surface snapshot\` to accept it`,
    );
    return 1;
  } finally {
    await runner.close();
  }
}
