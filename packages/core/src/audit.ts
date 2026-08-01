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
  /** Time spent waiting for a concurrency slot (docs/06 §audit; distinct
   * from execution — §7.1 observability). Settled invocations only. */
  queueWaitMs?: number;
  /** Time spent inside the handler/executor guards, excluding queue wait. */
  executionMs?: number;
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

/**
 * Development-time visibility, on the *diagnostic* stream.
 *
 * `console.debug` is the browser's verbose channel — the right home for a
 * per-event trace nobody explicitly asked to see. Node has no such channel:
 * there, `console.debug` is an alias of `console.log` and writes to **stdout**,
 * which is the stream a host that mounts this registry renders *its own output*
 * into. One registration is then enough to make `agent-surface inspect --json`
 * emit something no JSON parser accepts (AS-CLI-004), and a config deriving
 * `environment` from `import.meta.env.PROD` gets this sink under vite-node
 * without doing anything unusual.
 *
 * An audit trail is a diagnostic, not program output, so under Node it goes to
 * stderr. `console.error` rather than `process.stderr.write`: core stays
 * runtime-neutral, and a host that already intercepts the console keeps seeing
 * these events.
 */
export function consoleAuditSink(): AuditSink {
  return {
    record(event) {
      // eslint-disable-next-line no-console
      if (isNodeLike()) console.error("[agent-surface audit]", event.type, event);
      // eslint-disable-next-line no-console
      else console.debug("[agent-surface audit]", event.type, event);
    },
  };
}

/**
 * Node, not a bundler's `process` shim — only the real thing reports
 * `versions.node`. Read off `globalThis` so `core` needs no Node types.
 */
function isNodeLike(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: unknown } } }).process;
  return typeof proc?.versions?.node === "string";
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
