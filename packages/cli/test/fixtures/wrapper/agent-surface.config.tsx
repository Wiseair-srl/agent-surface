import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { Devices } from "./Callers.js";

export default {
  mount: () => ({
    registry: createAgentSurfaceRegistry({ environment: "test" }),
    ui: <Devices />,
  }),
  scenarios: { default: {} },
};
