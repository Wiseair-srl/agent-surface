import { dirname } from "node:path";
import { createSurfaceRunner } from "../load.js";
import { baselineDirFor } from "../baseline.js";
import { authoredIds, extractCapabilities, unresolved } from "../extract.js";
import {
  allowlistPathFor,
  buildCoverageReport,
  coverageExitCode,
  readAllowlist,
} from "../coverage.js";
import { renderCoveragePlain } from "../render/plain.js";
import { write } from "../output.js";

export interface CoverageOptions {
  configPath: string;
  scenario?: string;
  scope?: string[];
  tsconfig?: string;
  baselineDir?: string;
  json?: boolean;
  plain?: boolean;
}

/**
 * Joins the two halves: the static inventory (what is authored) against the
 * union of every scenario's explanation (what is reached).
 *
 * The join key is `capabilityId`, which is instance-independent by
 * construction — `instanceId` is not part of it — so two mounted instances of
 * one component collapse onto the one authored entry, which is what a coverage
 * question means.
 */
export async function runCoverage(options: CoverageOptions): Promise<number> {
  const root = dirname(options.configPath);
  const inventory = extractCapabilities({
    root,
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });

  const authored = authoredIds(inventory);
  const origins = new Map<string, { file: string; line: number }>();
  for (const capability of inventory.capabilities) {
    if (!origins.has(capability.capabilityId)) origins.set(capability.capabilityId, capability.origin);
  }

  const runner = await createSurfaceRunner(options.configPath);
  try {
    const scenarios = options.scenario ? [options.scenario] : runner.scenarioNames;
    const reachedIds = new Set<string>();

    for (const scenario of scenarios) {
      const result = await runner.collect({
        scenario,
        ...(options.scope ? { scope: options.scope } : {}),
      });
      // Reached means present in the *explanation*, not the snapshot — see
      // BuildCoverageInput.reachedIds for why hiding still counts as reaching.
      for (const capability of result.explanation.capabilities) {
        reachedIds.add(capability.capabilityId);
      }
    }

    const dir = baselineDirFor(
      options.configPath,
      options.baselineDir ?? runner.config.baselineDir,
    );
    const allowlistPath = allowlistPathFor(dir);
    const report = buildCoverageReport({
      authored,
      origins,
      reachedIds,
      scenarios,
      unresolved: unresolved(inventory),
      allowlist: readAllowlist(allowlistPath),
      allowlistPath,
    });

    if (options.json) write(JSON.stringify(report, null, 2));
    else write(renderCoveragePlain(report));

    // AS-CLI-002's contract: 0 clean, 1 a gap, 2 usage.
    return coverageExitCode(report);
  } finally {
    await runner.close();
  }
}
