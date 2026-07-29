import type { AgentCapabilityErrorCode } from "./errors.js";

export type AgentSurfaceEvent =
  | { type: "surface-changed"; surfaceVersion: string } // coalesced per microtask
  | {
      type: "component-registered";
      registrationId: string;
      componentType: string;
      instanceId: string;
    }
  | {
      type: "component-unregistered";
      registrationId: string;
      componentType: string;
      instanceId: string;
    }
  | {
      type: "component-rejected";
      componentType: string;
      instanceId: string;
      reason: "duplicate" | "guard";
    }
  | {
      type: "availability-changed";
      registrationId: string;
      capabilityId: string;
      available: boolean;
    }
  | { type: "collision-suspected"; viewCapabilityId: string; domainProcedureId: string }
  | { type: "invocation-started"; invocationId: string; capabilityId: string; consumerId: string }
  | {
      type: "invocation-settled";
      invocationId: string;
      capabilityId: string;
      status: "ok" | "error";
      code?: AgentCapabilityErrorCode;
      durationMs: number;
    }
  | {
      type: "confirmation-requested";
      confirmationId: string;
      capabilityId: string;
      expiresAt: string;
    }
  | {
      type: "confirmation-resolved";
      confirmationId: string;
      outcome: "approved" | "denied" | "expired";
    };

/**
 * Ordered, non-re-entrant event dispatcher (D17): events queue in mutation
 * order and drain one at a time; events emitted from listeners join the queue
 * and are delivered after the current event finishes; listener exceptions are
 * isolated and reported.
 */
export class EventDispatcher {
  private listeners = new Set<(event: AgentSurfaceEvent) => void>();
  private queue: AgentSurfaceEvent[] = [];
  private draining = false;

  constructor(private reportError: (err: unknown) => void) {}

  subscribe(listener: (event: AgentSurfaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentSurfaceEvent): void {
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      let next: AgentSurfaceEvent | undefined;
      while ((next = this.queue.shift()) !== undefined) {
        for (const listener of [...this.listeners]) {
          try {
            listener(next);
          } catch (err) {
            this.reportError(err);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  clear(): void {
    this.listeners.clear();
    this.queue.length = 0;
  }
}
