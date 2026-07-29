import type { AgentConsumer, JsonValue } from "./types.js";
import type { AgentCapabilityErrorPayload } from "./errors.js";

export interface AgentInvocation {
  /** Idempotency key. Adapters SHOULD pass their tool-call id. Generated if absent. */
  invocationId?: string;
  capabilityId: string; // "view:..." or "domain:..."
  /** Required when >1 live instance of the target component exists. */
  instanceId?: string;
  /** Staleness token from discovery. Adapters SHOULD always send it. */
  registrationId?: string;
  /** Version hint; enforced only for destructive/external effects. */
  surfaceVersion?: string;
  input?: JsonValue;
  /** Evidence from a resolved confirmation (docs/06). */
  confirmationId?: string;
}

export interface InvokeOptions {
  consumer?: AgentConsumer;
  signal?: AbortSignal; // external cancellation → CANCELLED
  timeoutMs?: number; // overrides capability/limits default
}

export type AgentInvocationResult =
  | {
      status: "ok";
      invocationId: string;
      capabilityId: string;
      output?: JsonValue; // validated against outputSchema if declared
      surfaceVersion: string; // current version at settle time
      /** Set when the surface changed during execution. */
      surfaceChanged?: boolean;
    }
  | {
      status: "error";
      invocationId: string;
      capabilityId: string;
      error: AgentCapabilityErrorPayload;
      surfaceVersion: string;
      surfaceChanged?: boolean;
    };
