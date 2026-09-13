export { createOrpcAgentBridge, isBridgeRef } from "./bridge.js";
export type {
  OrpcAgentBridge,
  OrpcAgentBridgeOptions,
  OrpcAgentManifest,
  AgentProcedureRef,
  RefsFor,
  ClientTree,
} from "./bridge.js";

export type { AgentProcedureBindingConfig } from "./binding.js";
export { createOrpcAgentManifest, createGovernedOrpcAgentBridge } from "./governed.js";
export type { PortableDomainCapability, GovernedDomainOutcome, GovernedDomainClient, GovernedOrpcAgentBridgeOptions } from "./governed.js";
