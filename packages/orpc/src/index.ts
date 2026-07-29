export { createOrpcAgentBridge, isBridgeRef } from "./bridge.js";
export type {
  OrpcAgentBridge,
  OrpcAgentBridgeOptions,
  OrpcAgentManifest,
  AgentProcedureRef,
  RefsFor,
  ClientTree,
} from "./bridge.js";

export { bindAgentProcedure, reduceInputSchema } from "./binding.js";
export type { AgentProcedureBindingConfig } from "./binding.js";
