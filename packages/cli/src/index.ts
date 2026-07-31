/**
 * `@agent-surface/cli` — inspect and check the agent surface your app exposes.
 *
 * The package root is the *authoring* API: `defineSurface()` and its types, for
 * your `agent-surface.config.*`. The commands live behind the `agent-surface`
 * binary, and `./vitest` reuses the same scenarios inside your test suite.
 */
export { defineSurface } from "./config.js";
export type { MountResult, ScenarioProps, SurfaceConfig } from "./config.js";
export type { CollectResult } from "./collect.js";
