import { AgentSurfaceError, type AgentProcedureEffect, type JsonSchema, type JsonValue, type ProcedureCallInfo } from "@agent-surface/core";
import { createOrpcAgentBridge, type OrpcAgentBridge, type OrpcAgentManifest } from "./bridge.js";

/** Structural subset of @orpc-agent/core/client. No server runtime is bundled. */
export interface PortableDomainCapability {
  version: 1;
  id: string;
  path: string[];
  description: string;
  inputSchema: JsonSchema;
  /** Only a declared model-output contract; ordinary RPC output may differ. */
  outputSchema?: JsonSchema;
  sideEffect: "none" | "read" | "write" | "destructive" | "external";
  requiresApproval?: boolean;
  contractDigest: string;
}

export type GovernedDomainOutcome =
  | { status: "completed"; invocationId: string; executionId: string; output: unknown }
  | { status: "approval-required"; invocationId: string; executionId: string; approval: { id: string; expiresAt?: string } }
  | { status: "failed" | "cancelled"; invocationId: string; executionId: string; error: { code: string; message: string; retryable?: boolean } }
  | { status: "outcome-unknown"; invocationId: string };

export interface GovernedDomainClient {
  invoke(capabilityId: string, input: unknown, options: {
    invocationId: string;
    correlationId?: string;
    contractDigest?: string;
    signal?: AbortSignal;
  }): Promise<GovernedDomainOutcome>;
}

export interface GovernedOrpcAgentBridgeOptions {
  client: GovernedDomainClient;
  /** Generated from the authority's portable descriptors; not an authorization grant. */
  manifest: OrpcAgentManifest;
  /** Receipt observer, for persisting approval/run mappings or invalidating app data. */
  onOutcome?: (outcome: GovernedDomainOutcome, info: ProcedureCallInfo) => void;
}

const effects: Record<PortableDomainCapability["sideEffect"], AgentProcedureEffect> = {
  none: "server-query", read: "server-query", write: "server-mutation", destructive: "destructive", external: "external-side-effect",
};

function assertDistinctPaths(paths: string[]): void {
  const sorted = [...paths].sort();
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.startsWith(`${sorted[index - 1]!}.`)) throw new TypeError("Conflicting portable domain paths.");
  }
}

/** Deterministic projection of backend-generated descriptors, without handlers. */
export function createOrpcAgentManifest(capabilities: readonly PortableDomainCapability[]): OrpcAgentManifest {
  const tools: OrpcAgentManifest["tools"] = Object.create(null);
  const ids = new Set<string>();
  for (const capability of capabilities) {
    if (capability.version !== 1 || !capability.id || !capability.contractDigest ||
      !Array.isArray(capability.path) || !capability.path.length ||
      capability.path.some((part) => !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part)) ||
      !Object.hasOwn(effects, capability.sideEffect)) throw new TypeError("Invalid portable domain capability.");
    const path = capability.path.join(".");
    if (Object.hasOwn(tools, path) || ids.has(capability.id)) throw new TypeError("Duplicate portable domain capability.");
    ids.add(capability.id);
    tools[path] = {
      description: capability.description, inputSchema: structuredClone(capability.inputSchema),
      ...(capability.outputSchema ? { outputSchema: structuredClone(capability.outputSchema) } : {}),
      effect: effects[capability.sideEffect],
      ...(capability.requiresApproval !== undefined ? { requiresApproval: capability.requiresApproval } : {}),
      capabilityId: capability.id, contractDigest: capability.contractDigest,
    };
  }
  assertDistinctPaths(Object.keys(tools));
  return { tools };
}

/**
 * Contextual input still executes through the agent gateway. The gateway fixes
 * trusted actor/surface; there is deliberately no client "surface: direct" option.
 * TClient is a type-only router contract, never a runtime procedure client.
 */
export function createGovernedOrpcAgentBridge<TClient extends object = Record<string, never>>(
  options: GovernedOrpcAgentBridgeOptions,
): OrpcAgentBridge<TClient> {
  assertDistinctPaths(Object.keys(options.manifest.tools));
  const client: Record<string, unknown> = Object.create(null);
  for (const [path, tool] of Object.entries(options.manifest.tools)) {
    if (!tool.capabilityId || !tool.contractDigest) throw new TypeError("Governed bridge requires a generated portable manifest.");
    let node = client;
    const parts = path.split(".");
    for (const part of parts) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part)) throw new TypeError("Invalid manifest path.");
    }
    for (const part of parts.slice(0, -1)) {
      node[part] ??= Object.create(null);
      node = node[part] as Record<string, unknown>;
    }
    node[parts.at(-1)!] = async (input: JsonValue, callOptions: { context: { info: ProcedureCallInfo } }) => {
      const info = callOptions.context.info;
      let outcome: GovernedDomainOutcome;
      try {
        outcome = await options.client.invoke(tool.capabilityId!, input, {
          invocationId: info.invocationId,
          correlationId: info.invocationId,
          contractDigest: tool.contractDigest,
          signal: info.signal,
        });
      } catch {
        // Dispatch may have reached the backend. Never suggest retrying an effect.
        throw new AgentSurfaceError({ code: "DOMAIN_OUTCOME_UNKNOWN", message: "The domain outcome is unknown. Reconcile the invocation before continuing.", retry: "no", details: { origin: "server", invocationId: info.invocationId } });
      }
      if (outcome.invocationId !== info.invocationId) {
        throw new AgentSurfaceError({ code: "DOMAIN_OUTCOME_UNKNOWN", message: "The domain response could not be correlated. Reconcile the invocation.", retry: "no", details: { origin: "server", invocationId: info.invocationId } });
      }
      try { options.onOutcome?.(outcome, info); } catch { /* Observer failure must not erase a domain receipt. */ }
      if (outcome.status === "completed") return outcome.output;
      if (outcome.status === "approval-required") throw new AgentSurfaceError({
        code: "DOMAIN_APPROVAL_REQUIRED", message: "The domain operation is waiting for server approval.", retry: "no",
        details: { origin: "server", invocationId: outcome.invocationId, executionId: outcome.executionId, approvalId: outcome.approval.id, ...(outcome.approval.expiresAt ? { expiresAt: outcome.approval.expiresAt } : {}) },
      });
      if (outcome.status === "outcome-unknown") throw new AgentSurfaceError({
        code: "DOMAIN_OUTCOME_UNKNOWN", message: "The domain outcome is unknown. Reconcile the invocation before continuing.", retry: "no", details: { origin: "server", invocationId: outcome.invocationId },
      });
      throw new AgentSurfaceError({
        code: ["UNAUTHORIZED", "FORBIDDEN", "NOT_AUTHORIZED", "NOT_AUTHENTICATED"].includes(outcome.error.code) ? "NOT_AUTHORIZED" : "EXECUTION_FAILED",
        message: "The domain operation did not complete.", retry: "no", details: { origin: "server" },
      });
    };
  }
  return createOrpcAgentBridge({
    client: client as TClient, manifest: options.manifest,
    callContext: (info) => ({ info }),
    mapServerError: (error) => error instanceof AgentSurfaceError ? error.payload : undefined,
  });
}
