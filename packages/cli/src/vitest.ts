/**
 * `@agent-surface/cli/vitest` — the same scenarios, inside your test suite.
 *
 * This is the point of putting scenarios in a config file rather than a CLI
 * fixture. A suite that mounts the app its own way is a second definition of
 * "admin on /devices" that silently drifts from the one CI checks. Import the
 * config instead:
 *
 * ```ts
 * import config from "../agent-surface.config.js";
 * import { mountScenario } from "@agent-surface/cli/vitest";
 *
 * const { surface, app } = await mountScenario(config, "admin");
 * expect(surface).toExpose("view:devices.filters.set");
 * ```
 *
 * No Vite server and no vite-node here: Vitest already provides the DOM and the
 * module graph, so this is the shared mount path called directly.
 */
export { mountScenario, DEFAULT_CLI_CONSUMER } from "./mount.js";
export type { MountScenarioOptions, MountedScenario } from "./mount.js";
export type { MountResult, ScenarioProps, SurfaceConfig } from "./config.js";
