import type { JsonValue } from "./types.js";

export type AgentCapabilityErrorCode =
  | "CAPABILITY_NOT_FOUND"
  | "CAPABILITY_NOT_AVAILABLE"
  | "AMBIGUOUS_INSTANCE"
  | "COMPONENT_UNMOUNTED"
  | "STALE_CAPABILITY"
  | "INVALID_INPUT"
  | "NOT_AUTHENTICATED"
  | "NOT_AUTHORIZED"
  | "PRECONDITION_FAILED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_INVALID"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "CANCELLED"
  | "EXECUTION_FAILED";

export type AgentErrorRetry =
  | "no"
  | "yes"
  | "after-refresh"
  | "after-delay"
  | "with-confirmation"
  | "with-changes";

export interface AgentCapabilityErrorPayload {
  code: AgentCapabilityErrorCode;
  /** Agent-safe, imperative, ≤ 300 chars. */
  message: string;
  retry: AgentErrorRetry;
  /** Code-specific, agent-safe, JsonValue only. */
  details?: Record<string, JsonValue>;
}

/** Thrown form used inside policies/handlers; serialized at the boundary. */
export class AgentSurfaceError extends Error {
  readonly payload: AgentCapabilityErrorPayload;
  constructor(payload: AgentCapabilityErrorPayload, opts?: { cause?: unknown }) {
    super(payload.message, opts);
    this.name = "AgentSurfaceError";
    this.payload = payload;
  }
}

export function isAgentSurfaceError(e: unknown): e is AgentSurfaceError {
  return (
    e instanceof AgentSurfaceError ||
    (typeof e === "object" &&
      e !== null &&
      (e as { name?: unknown }).name === "AgentSurfaceError" &&
      typeof (e as { payload?: unknown }).payload === "object")
  );
}

export type AgentSurfaceDefinitionErrorCode =
  | "INVALID_ID"
  | "INVALID_DEFINITION"
  | "UNSUPPORTED_SCHEMA"
  | "PLANE_VIOLATION"
  | "DUPLICATE_CAPABILITY"
  | "LIMIT_EXCEEDED";

/** Structural defects at registration time. Always thrown, never agent-facing. */
export class AgentSurfaceDefinitionError extends Error {
  readonly code: AgentSurfaceDefinitionErrorCode;
  constructor(code: AgentSurfaceDefinitionErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "AgentSurfaceDefinitionError";
    this.code = code;
  }
}
