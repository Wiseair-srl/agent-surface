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
import type {
  AgentConsumer,
  AgentSurfaceEvent,
  AgentSurfaceSnapshot,
  SnapshotContext,
} from "@agent-surface/core";
import type { SurfaceConfig } from "./config.js";
import { mountScenario } from "./mount.js";

export interface CollectOptions {
  scenario: string;
  consumer?: AgentConsumer;
  scope?: string[];
}

/**
 * A registration the registry refused while the scenario mounted (`AS-CLI-006`).
 *
 * Rejection is the one failure that is invisible everywhere else. The handle is
 * dead, so the capability never reaches the snapshot; the registration never
 * became active, so `explainSurface()` does not iterate it either. The only
 * diagnostic core emits goes through `devError`, which prints nothing unless
 * the app was built with `environment: "development"` — and the config shape
 * this CLI documents builds it with `"test"`.
 */
export interface RegistrationRejection {
  componentType: string;
  instanceId: string;
  reason: "duplicate" | "guard";
}

export interface CollectResult {
  scenario: string;
  snapshot: AgentSurfaceSnapshot;
  explanation: SurfaceExplanation;
  /** Refused during this mount. Empty on a healthy one. */
  rejections: RegistrationRejection[];
  /** The scope the two projections above were computed under, when one was set. */
  scope?: string[];
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
      // The harness subscribes to the registry when it is constructed, which is
      // before the tree renders — so this is the whole mount, not what happened
      // to still be pending when the render finished.
      rejections: rejectionsFrom(mount.surface.events()),
      ...(scope ? { scope } : {}),
    };
  } finally {
    mount.surface.dispose();
  }
}

function rejectionsFrom(events: readonly AgentSurfaceEvent[]): RegistrationRejection[] {
  const rejections: RegistrationRejection[] = [];
  for (const event of events) {
    if (event.type !== "component-rejected") continue;
    rejections.push({
      componentType: event.componentType,
      instanceId: event.instanceId,
      reason: event.reason,
    });
  }
  return rejections;
}

function jsonify<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
