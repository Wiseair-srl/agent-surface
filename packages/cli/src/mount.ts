import { act } from "@testing-library/react";
import { renderAgentSurface, type RenderedAgentSurface } from "@agent-surface/testing/react";
import type { AgentConsumer } from "@agent-surface/core";
import type { MountResult, ScenarioProps, SurfaceConfig } from "./config.js";

export const DEFAULT_CLI_CONSUMER: AgentConsumer = { id: "cli", kind: "test" };

export interface MountScenarioOptions {
  consumer?: AgentConsumer;
}

export interface MountedScenario<TApp> {
  scenario: string;
  surface: RenderedAgentSurface;
  mounted: MountResult<TApp>;
  /**
   * Whatever `mount()` returned as `app`. Typed as `TApp` rather than
   * `TApp | undefined` because a config that never sets it infers `TApp` as
   * `unknown`, and forcing a `!` on every test that *does* set it is worse
   * than trusting the config's own return type.
   */
  app: TApp;
  consumer: AgentConsumer;
}

/**
 * The one mounting path. `agent-surface inspect` and the Vitest helper both
 * come through here, so a scenario cannot behave one way in CI and another in
 * the terminal — which is the entire reason scenarios live in one file.
 */
export async function mountScenario<TScenario extends ScenarioProps, TApp>(
  config: SurfaceConfig<TScenario, TApp>,
  scenario: string,
  options: MountScenarioOptions = {},
): Promise<MountedScenario<TApp>> {
  const props = config.scenarios[scenario];
  if (!props) {
    const known = Object.keys(config.scenarios);
    throw new Error(
      `unknown scenario "${scenario}" — this config defines ${
        known.length > 0 ? known.map((name) => `"${name}"`).join(", ") : "none"
      }`,
    );
  }

  const consumer = options.consumer ?? config.consumer ?? DEFAULT_CLI_CONSUMER;
  const mounted = await config.mount({ ...props, scenario });
  const surface = await renderAgentSurface(mounted.ui, {
    registry: mounted.registry,
    consumer,
  });

  // Mount effects have flushed, but whatever the first render *started* has
  // not settled — the initial fetch that fills a table, typically. This flush
  // drains pending microtasks; `settle` covers anything slower.
  await act(async () => {});
  await config.settle?.(mounted);

  return { scenario, surface, mounted, app: mounted.app as TApp, consumer };
}
