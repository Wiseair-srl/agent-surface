import type { AgentEffect, JsonValue, Unsubscribe } from "./types.js";
import { jsonDeepEqual, randomBase62 } from "./utils.js";
import type { AgentSurfaceEvent } from "./events.js";
import type { AuditEvent } from "./audit.js";

export interface PendingConfirmation {
  confirmationId: string; // "cnf_" + random
  capabilityId: string;
  registrationId: string;
  /** Normalized consumer identity `kind:id` (D22). */
  consumerKey: string;
  /** Effect of the operation being approved. */
  effect: AgentEffect;
  /** Human-readable summary composed from description + effective input. */
  summary: string;
  /** The exact effective input (bound + agent-supplied) being approved. */
  input: JsonValue;
  requestedAt: string;
  expiresAt: string; // default TTL 120 s
}

export interface ConfirmationController {
  /** Pending requests, for host UI rendering. */
  pending(): PendingConfirmation[];
  resolve(confirmationId: string, resolution: { approved: boolean; reason?: string }): void;
  /** Resolves when the given confirmation settles (approved/denied/expired). */
  waitFor(
    confirmationId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<"approved" | "denied" | "expired">;
  subscribe(listener: (pending: PendingConfirmation[]) => void): Unsubscribe;
  /** Test hook: force-expire a record as if its TTL elapsed (docs/08). */
  forceExpire(confirmationId: string): void;
}

type RecordState = "pending" | "approved" | "denied" | "expired" | "consumed";

interface ConfirmationRecord extends PendingConfirmation {
  state: RecordState;
  /** Canonical request digest (D21): {surfaceId, registrationId,
   * capabilityId, consumerKey, effectiveInput, effect}. */
  digest: string;
  approvedAt?: string;
  denyReason?: string;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<(outcome: "approved" | "denied" | "expired") => void>;
}

export type ConsumeResult =
  | { ok: true; approvedAt: string }
  | { ok: false; kind: "pending-again"; record: PendingConfirmation }
  | { ok: false; kind: "invalid"; reason: "expired" | "denied" | "consumed" | "mismatch" };

const MAX_RETAINED_RESOLVED = 200;

export class ConfirmationStore {
  private records = new Map<string, ConfirmationRecord>();
  private listeners = new Set<(pending: PendingConfirmation[]) => void>();

  constructor(
    private readonly opts: {
      ttlMs: number;
      maxPending: number;
      now: () => number;
      emit: (event: AgentSurfaceEvent) => void;
      audit: (event: Omit<AuditEvent, "at">) => void;
    },
  ) {}

  /** Creates (or re-uses a matching pending) confirmation record.
   * Returns "overflow" when the bounded pending store is full (D24):
   * the caller fails RATE_LIMITED and no record is created. */
  request(request: {
    capabilityId: string;
    registrationId: string;
    consumerKey: string;
    effect: AgentEffect;
    input: JsonValue;
    summary: string;
    digest: string;
  }): PendingConfirmation | "overflow" {
    for (const record of this.records.values()) {
      if (record.state === "pending" && record.digest === request.digest) {
        return this.view(record);
      }
    }
    if (this.pendingCount() >= this.opts.maxPending) return "overflow";
    const now = this.opts.now();
    const record: ConfirmationRecord = {
      confirmationId: `cnf_${randomBase62(12)}`,
      capabilityId: request.capabilityId,
      registrationId: request.registrationId,
      consumerKey: request.consumerKey,
      effect: request.effect,
      summary: request.summary,
      input: request.input,
      digest: request.digest,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.ttlMs).toISOString(),
      state: "pending",
      waiters: [],
    };
    record.timer = setTimeout(() => this.expire(record.confirmationId), this.opts.ttlMs);
    this.records.set(record.confirmationId, record);
    this.trim();
    this.opts.emit({
      type: "confirmation-requested",
      confirmationId: record.confirmationId,
      capabilityId: record.capabilityId,
      expiresAt: record.expiresAt,
    });
    this.opts.audit({
      type: "confirmation-requested",
      capabilityId: record.capabilityId,
      registrationId: record.registrationId,
      consumerId: record.consumerKey,
      invocationId: undefined,
    });
    this.notify();
    return this.view(record);
  }

  private pendingCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state === "pending") count += 1;
    }
    return count;
  }

  resolve(confirmationId: string, resolution: { approved: boolean; reason?: string }): void {
    const record = this.records.get(confirmationId);
    if (!record || record.state !== "pending") return;
    if (record.timer) clearTimeout(record.timer);
    if (resolution.approved) {
      record.state = "approved";
      record.approvedAt = new Date(this.opts.now()).toISOString();
      this.opts.emit({ type: "confirmation-resolved", confirmationId, outcome: "approved" });
      this.opts.audit({
        type: "confirmation-approved",
        capabilityId: record.capabilityId,
        registrationId: record.registrationId,
        consumerId: record.consumerKey,
      });
      this.settleWaiters(record, "approved");
    } else {
      record.state = "denied";
      record.denyReason = resolution.reason;
      this.opts.emit({ type: "confirmation-resolved", confirmationId, outcome: "denied" });
      this.opts.audit({
        type: "confirmation-denied",
        capabilityId: record.capabilityId,
        registrationId: record.registrationId,
        consumerId: record.consumerKey,
      });
      this.settleWaiters(record, "denied");
    }
    this.notify();
  }

  expire(confirmationId: string): void {
    const record = this.records.get(confirmationId);
    if (!record || record.state !== "pending") return;
    if (record.timer) clearTimeout(record.timer);
    record.state = "expired";
    record.expiresAt = new Date(this.opts.now()).toISOString();
    this.opts.emit({ type: "confirmation-resolved", confirmationId, outcome: "expired" });
    this.opts.audit({
      type: "confirmation-expired",
      capabilityId: record.capabilityId,
      registrationId: record.registrationId,
      consumerId: record.consumerKey,
    });
    this.settleWaiters(record, "expired");
    this.notify();
  }

  /** Evidence validation + single-use consumption (docs/06 rules 2–5).
   * Matching is digest-first AND exact-value on the effective input —
   * never hash-only (AS-CONFIRM-002). */
  consume(evidence: {
    confirmationId: string;
    digest: string;
    input: JsonValue;
  }): ConsumeResult {
    const record = this.records.get(evidence.confirmationId);
    if (!record) return { ok: false, kind: "invalid", reason: "mismatch" };
    const matches =
      record.digest === evidence.digest && jsonDeepEqual(record.input, evidence.input);
    switch (record.state) {
      case "pending":
        return matches
          ? { ok: false, kind: "pending-again", record: this.view(record) }
          : { ok: false, kind: "invalid", reason: "mismatch" };
      case "denied":
        return { ok: false, kind: "invalid", reason: "denied" };
      case "expired":
        return { ok: false, kind: "invalid", reason: "expired" };
      case "consumed":
        return { ok: false, kind: "invalid", reason: "consumed" };
      case "approved": {
        if (Date.parse(record.expiresAt) < this.opts.now()) {
          record.state = "expired";
          return { ok: false, kind: "invalid", reason: "expired" };
        }
        if (!matches) return { ok: false, kind: "invalid", reason: "mismatch" };
        record.state = "consumed"; // atomic single use
        this.opts.audit({
          type: "confirmation-consumed",
          capabilityId: record.capabilityId,
          registrationId: record.registrationId,
          consumerId: record.consumerKey,
        });
        return { ok: true, approvedAt: record.approvedAt ?? record.requestedAt };
      }
    }
  }

  pending(): PendingConfirmation[] {
    return [...this.records.values()]
      .filter((r) => r.state === "pending")
      .map((r) => this.view(r));
  }

  waitFor(
    confirmationId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<"approved" | "denied" | "expired"> {
    const record = this.records.get(confirmationId);
    if (!record) return Promise.resolve("expired");
    if (record.state === "approved" || record.state === "consumed") return Promise.resolve("approved");
    if (record.state === "denied") return Promise.resolve("denied");
    if (record.state === "expired") return Promise.resolve("expired");
    return new Promise((resolvePromise) => {
      const waiter = (outcome: "approved" | "denied" | "expired"): void => resolvePromise(outcome);
      record.waiters.push(waiter);
      opts?.signal?.addEventListener(
        "abort",
        () => {
          const i = record.waiters.indexOf(waiter);
          if (i >= 0) record.waiters.splice(i, 1);
          resolvePromise("expired");
        },
        { once: true },
      );
    });
  }

  subscribe(listener: (pending: PendingConfirmation[]) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Expires every pending record (dispose path). */
  disposeAll(): void {
    for (const record of [...this.records.values()]) {
      if (record.state === "pending") this.expire(record.confirmationId);
    }
    this.listeners.clear();
  }

  controller(): ConfirmationController {
    return {
      pending: () => this.pending(),
      resolve: (id, resolution) => this.resolve(id, resolution),
      waitFor: (id, opts) => this.waitFor(id, opts),
      subscribe: (listener) => this.subscribe(listener),
      forceExpire: (id) => this.expire(id),
    };
  }

  private view(record: ConfirmationRecord): PendingConfirmation {
    return {
      confirmationId: record.confirmationId,
      capabilityId: record.capabilityId,
      registrationId: record.registrationId,
      consumerKey: record.consumerKey,
      effect: record.effect,
      summary: record.summary,
      input: record.input,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
    };
  }

  private settleWaiters(
    record: ConfirmationRecord,
    outcome: "approved" | "denied" | "expired",
  ): void {
    const waiters = record.waiters.splice(0);
    for (const waiter of waiters) waiter(outcome);
  }

  private notify(): void {
    const snapshot = this.pending();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // listener errors must not corrupt the store
      }
    }
  }

  private trim(): void {
    const resolved = [...this.records.values()].filter((r) => r.state !== "pending");
    if (resolved.length <= MAX_RETAINED_RESOLVED) return;
    for (const record of resolved.slice(0, resolved.length - MAX_RETAINED_RESOLVED)) {
      this.records.delete(record.confirmationId);
    }
  }
}
