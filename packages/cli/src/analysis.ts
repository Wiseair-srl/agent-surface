/**
 * The two halves of the surface, and the join between them.
 *
 * A presentation surface has two sources of truth, and every command needs
 * some mix of both:
 *
 * - the **catalog** — what this codebase authors. Static: `type` is a string
 *   literal, capability names are object keys, so `view:devices.table.sort` is
 *   fully determined by source text ([`extract.ts`](./extract.ts)).
 * - the **projection** — what a mounted scenario actually surfaces, after
 *   availability, policy and binding have had their say ([`collect.ts`](./collect.ts)).
 *
 * Splitting those across separate commands is what let a green `check` sit on
 * top of a route no scenario visits. So the split lives here, behind a `depth`
 * dial, and the commands compose the same three steps in whatever order their
 * output needs: `inspect` streams and closes with the verdict, `check` collects
 * and leads with it.
 */
import { dirname } from "node:path";
import { matchesScope } from "@agent-surface/core/explain";
import { baselineDirFor } from "./baseline.js";
import { UsageError, type Depth } from "./contract.js";
import type { CollectResult } from "./collect.js";
import {
  allowlistPathFor,
  buildCoverageReport,
  readAllowlist,
  unreadAllowlistPathFor,
  type CoverageReport,
} from "./coverage.js";
import {
  authoredIds,
  extractCapabilities,
  readLiteralConfigScope,
  unresolved,
  type CapabilityInventory,
} from "./extract.js";
import { createSurfaceRunner } from "./load.js";

export type { Depth } from "./contract.js";
export { UsageError } from "./contract.js";

export interface AnalysisOptions {
  configPath: string;
  depth: Depth;
  scenario?: string;
  scope?: string[];
  tsconfig?: string;
  baselineDir?: string;
}

/**
 * The static half. `undefined` at `--depth runtime`, which is the caller
 * saying it does not want this computed rather than it having failed.
 */
export function readInventory(options: AnalysisOptions): CapabilityInventory | undefined {
  if (options.depth === "runtime") return undefined;
  return extractCapabilities({
    root: dirname(options.configPath),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });
}

export function staticConfigScope(options: AnalysisOptions): string[] | undefined {
  return options.scope ?? readLiteralConfigScope(options.configPath);
}

/** A scenario the config declares whose mount threw. Named, never swallowed. */
export interface ScenarioFailure {
  scenario: string;
  message: string;
}

/**
 * Everything knowable once the config has loaded and before the first mount:
 * which scenarios will run, under which scope, against which manifest.
 *
 * Split out so a command can *say* what it is about to measure. The mounts are
 * the slow half — on a real app, seconds of them — and a report that opens with
 * its qualifiers only after they finish spends that time showing nothing and
 * then asks the reader to re-read the numbers above.
 */
export interface RuntimePlan {
  /** Scenarios selected for this run, in config order. */
  scenarios: string[];
  /** Every scenario declared by the config, even when one was selected. */
  declaredScenarios: string[];
  baselineDir: string;
  /** CLI scope wins; otherwise the config scope is effective everywhere. */
  scope?: string[];
  /** Authoritative domain capability ids from the configured oRPC manifest. */
  domainCapabilities: string[];
  domainManifestConfigured: boolean;
}

export interface RuntimeAnalysis extends RuntimePlan {
  /** The ones that mounted. */
  results: CollectResult[];
  failures: ScenarioFailure[];
}

export interface MountHooks {
  /** Called once, after the config loads and before the first mount. */
  onPlan?: (plan: RuntimePlan) => void | Promise<void>;
  /** Called as each scenario finishes, so a command can print as it goes. */
  onEach?: (result: CollectResult) => void | Promise<void>;
}

/**
 * The runtime half. `undefined` at `--depth static`.
 *
 * `onEach` is awaited as each scenario finishes, so a command can print as it
 * goes instead of after the last mount — a config with ten scenarios is a long
 * time to look at nothing.
 *
 * A scenario that throws is recorded and the run continues. Before this was
 * one command, `capabilities` was the only thing that still worked on an app
 * that would not mount; merging the commands would have thrown that away if a
 * single bad scenario could abort the run.
 */
export async function mountScenarios(
  options: AnalysisOptions,
  hooks: MountHooks = {},
): Promise<RuntimeAnalysis | undefined> {
  if (options.depth === "static") return undefined;

  const runner = await createSurfaceRunner(options.configPath);
  try {
    if (options.scenario && !runner.scenarioNames.includes(options.scenario)) {
      throw new UsageError(
        `unknown scenario "${options.scenario}" — this config defines ` +
          runner.scenarioNames.map((name) => `"${name}"`).join(", "),
      );
    }
    const scenarios = options.scenario ? [options.scenario] : runner.scenarioNames;
    const effectiveScope = options.scope ?? runner.config.scope;
    const results: CollectResult[] = [];
    const failures: ScenarioFailure[] = [];
    const plan: RuntimePlan = {
      scenarios,
      declaredScenarios: runner.scenarioNames,
      baselineDir: baselineDirFor(
        options.configPath,
        options.baselineDir ?? runner.config.baselineDir,
      ),
      ...(effectiveScope ? { scope: effectiveScope } : {}),
      domainCapabilities: Object.keys(runner.config.manifest?.tools ?? {})
        .map((path) => `domain:${path}`)
        .sort(),
      domainManifestConfigured: runner.config.manifest !== undefined,
    };
    await hooks.onPlan?.(plan);

    for (const scenario of scenarios) {
      let result: CollectResult;
      try {
        result = await runner.collect({
          scenario,
          ...(options.scope ? { scope: options.scope } : {}),
        });
      } catch (error) {
        failures.push({
          scenario,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      results.push(result);
      await hooks.onEach?.(result);
    }

    return { ...plan, results, failures };
  } finally {
    await runner.close();
  }
}

/**
 * The component type a capability id belongs to: `view:devices.table.sort` →
 * `devices.table`. Capability names are object keys and cannot contain a dot,
 * so the last one is always the boundary; component types can and do.
 */
function componentTypeOf(capabilityId: string): string {
  const withoutPlane = capabilityId.replace(/^(view|domain):/, "");
  const dot = withoutPlane.lastIndexOf(".");
  return dot === -1 ? withoutPlane : withoutPlane.slice(0, dot);
}

export function scopeInventory(
  inventory: CapabilityInventory | undefined,
  scope: string[] | undefined,
): CapabilityInventory | undefined {
  if (!inventory || !scope) return inventory;
  return {
    ...inventory,
    capabilities: inventory.capabilities.filter(
      (capability) =>
        capability.resolution === "unresolved" ||
        matchesScope(componentTypeOf(capability.capabilityId), scope),
    ),
  };
}

export function scopeCapabilityIds(ids: string[], scope: string[] | undefined): string[] {
  return scope ? ids.filter((id) => matchesScope(componentTypeOf(id), scope)) : ids;
}

/**
 * Authored minus reached (`AS-COVER-004…005`).
 *
 * Two ways this returns `undefined`, and neither is "no gaps":
 *
 * - a half was not computed, because the depth did not ask for it;
 * - **a scenario failed to mount.** That scenario reached nothing, so every
 *   capability it would have surfaced would be reported as one no scenario
 *   reaches. A coverage verdict computed over a partial run is precisely the
 *   misleading check this package refuses to emit, so there is no verdict
 *   until every scenario mounted. The renderer says which of the two it was.
 */
export function joinCoverage(
  inventory: CapabilityInventory | undefined,
  runtime: RuntimeAnalysis | undefined,
  options: AnalysisOptions,
): CoverageReport | undefined {
  if (!inventory || !runtime) return undefined;
  if (runtime.failures.length > 0) return undefined;

  // A scope filters the mount, so it has to filter the catalog by the same
  // predicate — core's own, not a second copy of it. Without this, `--scope
  // devices` reported every `app.navigation` capability as unreached, with the
  // words "no scenario mounts it" over two that both scenarios mount.
  const effectiveScope = options.scope ?? runtime.scope;
  const inScope = (capabilityId: string): boolean =>
    matchesScope(componentTypeOf(capabilityId), effectiveScope);

  const origins = new Map<string, { file: string; line: number }>();
  for (const capability of inventory.capabilities) {
    if (!origins.has(capability.capabilityId)) {
      origins.set(capability.capabilityId, capability.origin);
    }
  }

  const authored = new Set([...authoredIds(inventory)].filter(inScope));
  for (const capabilityId of runtime.domainCapabilities) {
    if (inScope(capabilityId)) authored.add(capabilityId);
    if (!origins.has(capabilityId)) {
      origins.set(capabilityId, { file: "oRPC manifest", line: 0 });
    }
  }
  const reachedIds = new Set<string>();
  for (const result of runtime.results) {
    for (const capability of result.explanation.capabilities) {
      reachedIds.add(capability.capabilityId);
    }
  }

  // The allowlist is a statement about the whole catalog, and a scoped run has
  // only looked at part of it. Judging an out-of-scope entry either way would
  // be wrong in both directions — it is not an unreached capability this run
  // waved through, and it is not a stale entry either, because nothing here
  // reached it.
  const allowlistPath = allowlistPathFor(runtime.baselineDir);
  const wholeAllowlist = readAllowlist(allowlistPath);
  const allowlist = Object.fromEntries(
    Object.entries(wholeAllowlist).filter(([id]) => inScope(id)),
  );

  // Not scope-filtered, deliberately: an unread call site has no capability id,
  // so there is no component type to test a scope prefix against. A scoped run
  // simply reports the same unread sites as an unscoped one.
  const unreadAllowlistPath = unreadAllowlistPathFor(runtime.baselineDir);

  return buildCoverageReport({
    unreadAllowlist: readAllowlist(unreadAllowlistPath, "file#reason#site"),
    unreadAllowlistPath,
    domainAuthoritative: runtime.domainManifestConfigured,
    authored,
    origins,
    reachedIds,
    scenarios: runtime.scenarios,
    ...(effectiveScope ? { scope: effectiveScope } : {}),
    unresolved: unresolved(inventory),
    allowlist,
    allowlistOutOfScope: Object.keys(wholeAllowlist).length - Object.keys(allowlist).length,
    allowlistPath,
  });
}
