import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { Mounted } from "./Mounted.js";

/**
 * One scenario, one component. `Unmounted.tsx` and `Dynamic.tsx` are authored
 * in the same program and reached by nothing here — which is the entire point:
 * a coverage gap is invisible to `inspect`, `--explain` and `check` alike,
 * because all three can only see what a scenario mounted.
 *
 * `defineSurface` is deliberately not imported — a fixture inside the package
 * cannot resolve the package by name, and the helper is an identity function
 * whose only job is inference.
 */
export default {
  mount: () => ({
    registry: createAgentSurfaceRegistry({ environment: "test" }),
    ui: <Mounted />,
  }),
  scenarios: { default: {} },
};
