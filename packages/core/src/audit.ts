import type { JsonValue } from "./types.js";
import type { AgentCapabilityErrorCode } from "./errors.js";

export interface AuditEvent {
  at: string; // ISO-8601
  type:
    | "registration"
    | "unregistration"
    | "registration-rejected"
    | "invocation-started"
    | "invocation-settled"
    | "confirmation-requested"
    | "confirmation-approved"
    | "confirmation-denied"
    | "confirmation-expired"
    | "confirmation-consumed"
    | "late-settlement"
    | "collision-suspected";
  capabilityId?: string;
  registrationId?: string;
  invocationId?: string;
  consumerId?: string;
  status?: "ok" | "error";
  code?: AgentCapabilityErrorCode;
  durationMs?: number;
  /** Present only for capabilities with audit: "full"; size-capped. */
  payload?: { input?: JsonValue; output?: JsonValue };
}

export interface AuditSink {
  /** MUST NOT throw; MUST be non-blocking. */
  record(event: AuditEvent): void;
}

export function memoryAuditSink(opts?: {
  capacity?: number;
}): AuditSink & { events(): AuditEvent[] } {
  const capacity = opts?.capacity ?? 1000;
  const buffer: AuditEvent[] = [];
  return {
    record(event) {
      buffer.push(event);
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    },
    events() {
      return [...buffer];
    },
  };
}

export function consoleAuditSink(): AuditSink {
  return {
    record(event) {
      // eslint-disable-next-line no-console
      console.debug("[agent-surface audit]", event.type, event);
    },
  };
}

/** Sinks MUST NOT break the registry: exceptions are swallowed (and logged). */
export function safeRecord(sink: AuditSink | undefined, event: AuditEvent): void {
  if (!sink) return;
  try {
    sink.record(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[agent-surface] audit sink threw", err);
  }
}
