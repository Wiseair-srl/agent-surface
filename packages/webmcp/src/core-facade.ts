export { encodeWireName, encodeWireNameForInstance } from "@agent-surface/core";
export type {
  AgentCapabilityDescriptorUnion,
  AgentConsumer,
  AgentSurfaceRegistry,
  JsonSchema,
  JsonValue,
  SnapshotContext,
} from "@agent-surface/core";

export function randomInvocationId(): string {
  return `inv_${Math.random().toString(36).slice(2, 14)}`;
}
