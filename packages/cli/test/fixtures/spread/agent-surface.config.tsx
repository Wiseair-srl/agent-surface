import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { SpreadInstanceId } from "./Shapes.js";

export default {
  mount: () => ({
    registry: createAgentSurfaceRegistry({ environment: "test" }),
    ui: <SpreadInstanceId />,
  }),
  scenarios: { default: {} },
};
