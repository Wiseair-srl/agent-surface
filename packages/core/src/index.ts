/**
 * @agent-surface/core — framework-agnostic registry, types, schema layer,
 * policy pipeline, confirmation, audit, toolset, and errors for frontend
 * agent surfaces. Zero runtime dependencies (docs/02).
 */

export type {
  JsonValue,
  JsonSchema,
  AgentEnvironment,
  AgentEffect,
  AgentProcedureEffect,
  AgentConsumer,
  AgentRouteInfo,
  AgentSurfaceLimits,
  AgentConcurrency,
  Unsubscribe,
} from "./types.js";
export { DEFAULT_LIMITS } from "./types.js";

export {
  AgentSurfaceError,
  AgentSurfaceDefinitionError,
  isAgentSurfaceError,
  AGENT_CAPABILITY_ERROR_CODES,
} from "./errors.js";
export type {
  AgentCapabilityErrorCode,
  AgentErrorRetry,
  AgentCapabilityErrorPayload,
  AgentSurfaceDefinitionErrorCode,
} from "./errors.js";

export {
  parseCapabilityId,
  formatViewCapabilityId,
  formatDomainCapabilityId,
  isValidComponentType,
  isValidCapabilityName,
  isValidInstanceId,
  encodeWireName,
  encodeWireNameForInstance,
  assignWireNames,
  decodeWireName,
  MAX_ID_LENGTH,
  MAX_WIRE_NAME_LENGTH,
} from "./ids.js";
export type {
  AgentPlane,
  ParsedCapabilityId,
  WireNameEntry,
  WireNameAssignment,
} from "./ids.js";

export {
  AgentSchemaError,
  fromStandardSchema,
  fromJsonSchema,
  emptyObjectSchema,
  validateJsonSchemaDocument,
  validateValueAgainstSchema,
} from "./schema.js";
export type { AgentSchema, AgentSchemaIssue, StandardSchemaV1 } from "./schema.js";

export {
  observation,
  action,
  defineAgentComponent,
  validateComponentDefinition,
} from "./definition.js";
export type {
  AgentReadContext,
  AgentActionContext,
  PreconditionFailure,
  AgentObservationDefinition,
  AgentActionDefinition,
  AgentComponentDefinition,
  AgentProcedureBinding,
  AgentProcedureBindingRuntimeConfig,
  AgentProcedureRefDescriptor,
  AgentProcedureExecutor,
  ProcedureCallInfo,
} from "./definition.js";

export {
  evaluateDiscovery,
  composeInvokeChain,
  authenticated,
  hasPermission,
  tenantBoundary,
  environment,
  rateLimit,
  requireConfirmation,
  audit,
  CONFIRMATION_ESCALATION,
} from "./policy.js";
export type {
  AgentPolicy,
  AgentPolicyContext,
  AgentAuthorizationContext,
  AgentInvocationPolicyContext,
  DiscoveryDecision,
  ConfirmationEscalation,
} from "./policy.js";

export { memoryAuditSink, consoleAuditSink } from "./audit.js";
export type { AuditEvent, AuditSink } from "./audit.js";

export type { AgentSurfaceEvent } from "./events.js";

export type { PendingConfirmation, ConfirmationController } from "./confirmation.js";

export type {
  AgentInvocation,
  InvokeOptions,
  AgentInvocationResult,
} from "./invocation-types.js";

export { createAgentSurfaceRegistry } from "./registry.js";
export type {
  AgentSurfaceRegistry,
  AgentRegistrationHandle,
  RegistryOptions,
  RegistrationCandidate,
} from "./registry.js";

export type {
  SnapshotContext,
  AgentSurfaceSnapshot,
  AgentComponentDescriptor,
  AgentObservationDescriptor,
  AgentActionDescriptor,
  AgentProcedureDescriptor,
  AgentCapabilityDescriptorUnion,
} from "./snapshot.js";

export { createAgentToolset } from "./toolset.js";
export type { AgentToolset, AgentToolsetOptions, AgentTool } from "./toolset.js";

export { jsonDeepEqual } from "./utils.js";

export {
  CAPABILITY_CONTRACT_FORMAT_VERSION,
  observationContract,
  actionContract,
  defineAgentComponentContract,
  defineAgentProcedureContract,
  defineExternalAgentToolContract,
  createCapabilityAuthority,
  deriveAgentComponentBinding,
  authorizeAgentProcedureBinding,
  assertDefinitionAuthorized,
  createAgentExposureGateway,
} from "./contract.js";
export type {
  CapabilityAuthority,
  CapabilityContractKind,
  CapabilityPolicyAttachment,
  CapabilityContractEntry,
  ExternalCapabilityContractDigest,
  CapabilityContractManifest,
  AgentObservationContract,
  AgentActionContract,
  AgentComponentContractDefinition,
  AgentComponentRuntimeBindings,
  AgentComponentContract,
  ExternalAgentToolContractDefinition,
  AgentProcedureContractDefinition,
  AgentProcedureContract,
  CompiledExternalAgentTool,
  ExternalAgentToolContract,
  AgentExposureGateway,
} from "./contract.js";
