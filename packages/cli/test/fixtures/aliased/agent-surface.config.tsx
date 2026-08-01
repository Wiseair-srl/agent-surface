import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { AliasedPanel } from "./Aliased.js";

export default {
  mount: () => ({
    registry: createAgentSurfaceRegistry({ environment: "test" }),
    ui: <AliasedPanel />,
  }),
  scenarios: { default: {} },
};
