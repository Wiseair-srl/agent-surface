import type { ReactElement } from "react";
import type { AgentConsumer, AgentSurfaceRegistry } from "@agent-surface/core";

/** Structural subset of the authoritative orpc-agent manifest the CLI consumes. */
export interface SurfaceDomainManifest {
  tools: Record<string, { description: string }>;
}

/** What `mount()` hands back: the app's own registry and its rendered tree. */
export interface MountResult<TApp = unknown> {
  registry: AgentSurfaceRegistry;
  ui: ReactElement;
  /**
   * Anything else your tests need back — the app wiring, a backend double, a
   * router handle. The CLI ignores it entirely; it exists so the same scenario
   * can drive `agent-surface inspect` and a Vitest suite without the suite
   * having to rebuild the app a second way.
   */
  app?: TApp;
}

/**
 * Scenario properties are whatever your `mount()` needs — a user, a route, a
 * feature flag. The CLI never interprets them; it just hands them back, plus
 * `scenario` (the key it was listed under).
 */
export type ScenarioProps = Record<string, unknown>;

export interface SurfaceConfig<TScenario extends ScenarioProps = ScenarioProps, TApp = unknown> {
  /**
   * Build the app the way the app builds itself. This should point at your
   * existing composition root, not restate it — whatever `main.tsx` calls.
   */
  mount(
    props: TScenario & { scenario: string },
  ): MountResult<TApp> | Promise<MountResult<TApp>>;

  /**
   * Optional extra settling after mount effects flush, for anything the first
   * render kicks off asynchronously (an initial fetch, a router resolve).
   * The CLI already flushes React effects and pending microtasks for you.
   */
  settle?: (mounted: MountResult<TApp>) => void | Promise<void>;

  /** Named surfaces to inspect and check. At least one is required. */
  scenarios: Record<string, TScenario>;

  /** Consumer identity snapshots are computed for. Default `{id:"cli",kind:"test"}`. */
  consumer?: AgentConsumer;

  /** Component-type prefixes to restrict to, same meaning as `SnapshotContext.scope`. */
  scope?: string[];

  /** Authoritative domain denominator. Full analysis joins every manifest tool. */
  manifest?: SurfaceDomainManifest;

  /** Where `snapshot`/`check` keep baselines. Default `.agent-surface`, relative to the config. */
  baselineDir?: string;
}

/**
 * Identity function that exists purely for type inference — the same shape as
 * Vite's `defineConfig`. Your scenario props stay strongly typed inside
 * `mount()` without you annotating them.
 */
export function defineSurface<TScenario extends ScenarioProps, TApp = unknown>(
  config: SurfaceConfig<TScenario, TApp>,
): SurfaceConfig<TScenario, TApp> {
  return config;
}
