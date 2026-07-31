/**
 * The collector — the *only* module the CLI executes inside the vite-node
 * graph, and the reason that boundary exists.
 *
 * Two things force it:
 *
 * 1. **One React.** The app's component tree resolves React through the app's
 *    own Vite config. If the mount ran in the CLI's Node graph instead, a
 *    second React copy would render it and every hook would throw.
 *
 * 2. **One `@agent-surface/core`.** `explainSurface()` reaches the registry
 *    through a plain `Symbol` seam, and a symbol is only equal to itself within
 *    one module instance. Load core twice and the seam silently misses. So the
 *    explanation is computed *here*, beside the registry that owns it.
 *
 * Everything crosses back as plain JSON. Nothing live — no registry, no React
 * element, no policy function — escapes into the CLI process.
 */
import { explainSurface, type SurfaceExplanation } from "@agent-surface/core/explain";
import type { AgentConsumer, AgentSurfaceSnapshot, SnapshotContext } from "@agent-surface/core";
import type { SurfaceConfig } from "./config.js";
import { mountScenario } from "./mount.js";

export interface CollectOptions {
  scenario: string;
  consumer?: AgentConsumer;
  scope?: string[];
}

export interface CollectResult {
  scenario: string;
  snapshot: AgentSurfaceSnapshot;
  explanation: SurfaceExplanation;
}

export async function collect(
  config: SurfaceConfig,
  options: CollectOptions,
): Promise<CollectResult> {
  const mount = await mountScenario(config, options.scenario, {
    ...(options.consumer ? { consumer: options.consumer } : {}),
  });
  const scope = options.scope ?? config.scope;
  const ctx: SnapshotContext = {
    consumer: mount.consumer,
    includeUnavailable: true,
    ...(scope ? { scope } : {}),
  };

  try {
    return {
      scenario: options.scenario,
      // Inert copies: the live objects are frozen and graph-local, and only
      // plain JSON may cross back into the CLI process.
      snapshot: jsonify(mount.mounted.registry.snapshot(ctx)),
      explanation: jsonify(explainSurface(mount.mounted.registry, ctx)),
    };
  } finally {
    mount.surface.dispose();
  }
}

function jsonify<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
