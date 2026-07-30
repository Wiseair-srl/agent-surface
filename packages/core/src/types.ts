/** JSON value constraint: every agent-crossing payload MUST be a JsonValue. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON Schema document restricted to the supported subset (docs/03 D19). */
export type JsonSchema = Record<string, unknown>;

export type AgentEnvironment = "development" | "production" | "test";

export type AgentEffect =
  | "read"
  | "local-state"
  | "navigation"
  | "server-query"
  | "server-mutation"
  | "external-side-effect"
  | "destructive";

export type AgentProcedureEffect =
  | "server-query"
  | "server-mutation"
  | "external-side-effect"
  | "destructive";

export interface AgentConsumer {
  id: string;
  kind: "embedded" | "webmcp" | "mcp-bridge" | "test" | "other";
  /** Free-form grant strings interpreted by host policies. */
  grants?: string[];
}

export interface AgentRouteInfo {
  path: string;
  params?: Record<string, string>;
}

/**
 * Concurrency group for an action or procedure reference (D25). Not
 * model-visible: it is runtime behavior, not planning information.
 *
 * - `instance` (default) — every action on the registration shares one FIFO
 *   queue. Safest: two actions on the same component can never interleave.
 * - `capability` — one queue per capability, so a slow export does not block
 *   closing a drawer.
 * - `key` — one queue per author-chosen key, for actions that contend over
 *   the same resource across capabilities.
 * - `parallel` — bounded parallelism; `max` is required and must be ≥ 1.
 *
 * `queueDepth` overrides `limits.actionQueueDepth` for this group only.
 */
export type AgentConcurrency =
  | { mode: "instance"; queueDepth?: number }
  | { mode: "capability"; queueDepth?: number }
  | { mode: "key"; key: string; queueDepth?: number }
  | { mode: "parallel"; max: number; queueDepth?: number };

export interface AgentSurfaceLimits {
  maxComponentDescription: number; // 500 chars
  maxCapabilityDescription: number; // 300 chars
  maxMetaBytes: number; // 2048
  maxOutputBytes: number; // 32_768
  maxSchemaBytes: number; // 16_384
  maxSchemaDepth: number; // 8
  observationTimeoutMs: number; // 5_000
  actionTimeoutMs: number; // 10_000
  procedureTimeoutMs: number; // 30_000
  actionQueueDepth: number; // 2
  maxConcurrentObservationsPerConsumer: number; // 8 (D24)
  maxConcurrentObservationsTotal: number; // 32 (D24)
  maxQueuedObservationsPerConsumer: number; // 8 (D24)
  dedupeCacheSize: number; // 200 entries
  dedupeCacheTtlMs: number; // 600_000
  tombstoneSize: number; // 100 entries
  tombstoneTtlMs: number; // 300_000
  confirmationTtlMs: number;
  maxPendingConfirmations: number; // 32 (D24; overflow fails RATE_LIMITED, no record) // 120_000
}

export const DEFAULT_LIMITS: AgentSurfaceLimits = {
  maxComponentDescription: 500,
  maxCapabilityDescription: 300,
  maxMetaBytes: 2048,
  maxOutputBytes: 32_768,
  maxSchemaBytes: 16_384,
  maxSchemaDepth: 8,
  observationTimeoutMs: 5_000,
  actionTimeoutMs: 10_000,
  procedureTimeoutMs: 30_000,
  actionQueueDepth: 2,
  maxConcurrentObservationsPerConsumer: 8,
  maxConcurrentObservationsTotal: 32,
  maxQueuedObservationsPerConsumer: 8,
  dedupeCacheSize: 200,
  dedupeCacheTtlMs: 600_000,
  tombstoneSize: 100,
  tombstoneTtlMs: 300_000,
  confirmationTtlMs: 120_000,
  maxPendingConfirmations: 32,
};

export type Unsubscribe = () => void;
