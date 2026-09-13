import type { AgentSurfaceRegistry } from "./registry.js";
import type { AgentInvocation, AgentInvocationResult } from "./invocation-types.js";
import type { AgentSurfaceSnapshot } from "./snapshot.js";
import type { AgentConsumer, JsonValue, Unsubscribe } from "./types.js";
import { canonicalJson, deepFreeze } from "./utils.js";

export interface BrowserSurfaceIdentity {
  appId: string;
  buildId: string;
  /** Opaque authenticated session binding, never a bearer token. */
  sessionId: string;
  /** Unique per document lifetime. Do not restore from sessionStorage after reload. */
  tabId: string;
}

export interface BrowserSurfaceAnnouncement {
  protocolVersion: 1;
  type: "surface-announcement";
  identity: BrowserSurfaceIdentity;
  connectionId: string;
  snapshot: AgentSurfaceSnapshot;
}

export interface BrowserSurfaceCall {
  protocolVersion: 1;
  type: "surface-call";
  identity: BrowserSurfaceIdentity;
  connectionId: string;
  runId: string;
  toolCallId: string;
  invocation: AgentInvocation & {
    invocationId: string;
    registrationId: string;
    surfaceVersion: string;
  };
}

export type BrowserSurfaceRejection =
  | "disconnected"
  | "wrong-session"
  | "stale-surface"
  | "invocation-conflict"
  | "session-expired"
  | "capacity-exceeded"
  | "invalid-call";

export interface BrowserSurfaceResult {
  protocolVersion: 1;
  type: "surface-result";
  identity: BrowserSurfaceIdentity;
  connectionId: string;
  runId: string;
  toolCallId: string;
  invocationId: string;
  result: AgentInvocationResult | { status: "rejected"; reason: BrowserSurfaceRejection };
}

export interface BrowserSurfaceSessionOptions {
  registry: AgentSurfaceRegistry;
  identity: BrowserSurfaceIdentity;
  /** Host-assigned consumer identity used by discovery AND invocation policies. */
  consumer?: AgentConsumer;
  /** Maximum admitted calls and connections; no eviction. Default 1000. */
  maxEntries?: number;
  /** Entire adapter lifetime, including cached results. Default 30 minutes. */
  ttlMs?: number;
  now?: () => number;
}

export interface BrowserSurfaceSession {
  connect(connectionId: string): BrowserSurfaceAnnouncement;
  disconnect(): void;
  announcement(): BrowserSurfaceAnnouncement | null;
  /** Send announcements through the application's authenticated transport. */
  subscribe(listener: (announcement: BrowserSurfaceAnnouncement) => void): Unsubscribe;
  invoke(call: BrowserSurfaceCall): Promise<BrowserSurfaceResult>;
  dispose(): void;
}

/**
 * Transport-independent browser endpoint. The host authenticates the socket,
 * checks announcements against known build contracts, and correlates results
 * with its outstanding run/tool call. This adapter never grants domain authority.
 */
export function createBrowserSurfaceSession(options: BrowserSurfaceSessionOptions): BrowserSurfaceSession {
  const { registry } = options;
  const identity = Object.freeze({ ...options.identity });
  const identityKeys = ["appId", "buildId", "sessionId", "tabId"] as const;
  if (identityKeys.some((key) => typeof identity[key] !== "string" || !identity[key] || identity[key].length > 512)) {
    throw new TypeError("Browser surface identity fields must be nonempty strings of at most 512 characters.");
  }
  const maxEntries = options.maxEntries ?? 1000;
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("maxEntries and ttlMs must be positive finite bounds.");
  }
  const now = options.now ?? Date.now;
  const expiresAt = now() + ttlMs;
  const consumer = options.consumer ?? { id: identity.sessionId, kind: "embedded" as const };
  let connectionId: string | undefined;
  let disposed = false;
  const connections = new Set<string>();
  const entries = new Map<string, { fingerprint: string; promise: Promise<BrowserSurfaceResult> }>();
  const active = new Set<AbortController>();
  const listeners = new Set<(announcement: BrowserSurfaceAnnouncement) => void>();
  const expired = () => now() >= expiresAt;
  const disconnect = () => {
    connectionId = undefined;
    for (const controller of active) controller.abort();
  };
  const sweep = () => {
    if (!expired()) return;
    disconnect();
    entries.clear();
    connections.clear();
    listeners.clear();
  };
  const announcement = (): BrowserSurfaceAnnouncement | null => {
    sweep();
    if (disposed || !connectionId) return null;
    return { protocolVersion: 1, type: "surface-announcement", identity, connectionId, snapshot: registry.snapshot({ consumer }) };
  };
  const unsubscribe = registry.subscribe((event) => {
    if (event.type !== "surface-changed") return;
    const next = announcement();
    if (next) for (const listener of listeners) {
      try { listener(next); } catch { /* Transport observers cannot affect execution. */ }
    }
  });
  return {
    connect(nextConnectionId) {
      sweep();
      if (disposed || expired()) throw new Error("Browser surface session expired or disposed; create a new session.");
      if (!nextConnectionId || nextConnectionId.length > 512) throw new TypeError("Invalid connection ID.");
      if (connections.has(nextConnectionId)) throw new Error("Connection IDs cannot be reused.");
      if (connections.size >= maxEntries) throw new Error("Browser surface connection capacity exceeded.");
      disconnect();
      connections.add(nextConnectionId);
      connectionId = nextConnectionId;
      return announcement()!;
    },
    disconnect,
    announcement,
    subscribe(listener) {
      sweep();
      if (disposed || expired()) throw new Error("Browser surface session expired or disposed.");
      if (listeners.size >= maxEntries) throw new Error("Browser surface listener capacity exceeded.");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async invoke(call) {
      const raw = call as unknown;
      const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Partial<BrowserSurfaceCall> : {};
      const stringField = (value: unknown) => typeof value === "string" ? value : "";
      const envelope = {
        protocolVersion: 1 as const, type: "surface-result" as const,
        identity, connectionId: stringField(record.connectionId), runId: stringField(record.runId), toolCallId: stringField(record.toolCallId),
        invocationId: stringField(record.invocation?.invocationId),
      };
      const reject = (reason: BrowserSurfaceRejection): BrowserSurfaceResult => ({ ...envelope, result: { status: "rejected", reason } });
      sweep();
      if (expired()) return reject("session-expired");
      if (disposed || !connectionId) return reject("disconnected");
      if (record !== raw) return reject("invalid-call");
      if (call.protocolVersion !== 1 || call.type !== "surface-call" ||
        [call.runId, call.toolCallId, call.invocation?.invocationId, call.invocation?.capabilityId,
          call.invocation?.registrationId, call.invocation?.surfaceVersion].some((value) => typeof value !== "string" || !value || value.length > 512)) return reject("invalid-call");
      if (!call.identity || identityKeys.some((key) => call.identity[key] !== identity[key])) return reject("wrong-session");
      if (call.connectionId !== connectionId) return reject("disconnected");
      let fingerprint: string;
      try { fingerprint = canonicalJson(call as unknown as JsonValue); } catch { return reject("invalid-call"); }
      if (fingerprint.length > 262_144) return reject("invalid-call");
      const existing = entries.get(call.invocation.invocationId);
      if (existing) return existing.fingerprint === fingerprint ? existing.promise : reject("invocation-conflict");
      if (entries.size >= maxEntries) return reject("capacity-exceeded");
      const snapshot = registry.snapshot({ consumer });
      if (call.invocation.surfaceVersion !== snapshot.surfaceVersion) return reject("stale-surface");
      const inv = call.invocation;
      const present = snapshot.components.some((component) =>
        component.registrationId === inv.registrationId &&
        (!inv.instanceId || component.instanceId === inv.instanceId) &&
        [...component.actions, ...component.observations].some((capability) => capability.capabilityId === inv.capabilityId)) ||
        snapshot.procedures.some((procedure) => procedure.registrationId === inv.registrationId && procedure.procedureId === inv.capabilityId);
      if (!present) return reject("stale-surface");
      const controller = new AbortController();
      active.add(controller);
      // Capture before dispatch; never forward a mutable transport object.
      const invocation = JSON.parse(JSON.stringify(inv)) as BrowserSurfaceCall["invocation"];
      const promise = Promise.resolve().then(async (): Promise<BrowserSurfaceResult> => {
        if (controller.signal.aborted || connectionId !== envelope.connectionId) return reject("disconnected");
        if (expired()) return reject("session-expired");
        if (registry.getVersion() !== invocation.surfaceVersion) return reject("stale-surface");
        return { ...envelope, result: await registry.invoke(invocation, { consumer, signal: controller.signal }) };
      })
        .then((result) => deepFreeze(result))
        .finally(() => { active.delete(controller); });
      entries.set(inv.invocationId, { fingerprint, promise });
      return promise;
    },
    dispose() {
      disposed = true;
      disconnect();
      unsubscribe();
      entries.clear();
      connections.clear();
      listeners.clear();
    },
  };
}
