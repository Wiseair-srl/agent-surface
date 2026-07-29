import {
  AgentSurfaceError,
  type AgentProcedureEffect,
  type AgentProcedureExecutor,
  type JsonSchema,
  type JsonValue,
  type ProcedureCallInfo,
} from "@agent-surface/core";

/**
 * [Experimental] Minimal contract this package needs from orpc-agent
 * (docs/05, OQ-1). Derivable from a build-time export of the capability
 * registry inventory or a bootstrap `runtime.describe()` fetch; hand-writing
 * it remains the escape hatch.
 */
export interface OrpcAgentManifest {
  tools: Record<
    string, // key: dot path, "devices.disable"
    {
      description: string;
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
      effect: AgentProcedureEffect;
      /** Server-declared flags the client must respect (e.g. approval required). */
      requiresApproval?: boolean;
    }
  >;
}

export interface AgentProcedureRef<TIn extends object, TOut> {
  readonly id: string; // "domain:devices.disable"
  readonly path: string; // "devices.disable"
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly effect: AgentProcedureEffect;
  readonly requiresApproval?: boolean;
  call(input: TIn, ctx: ProcedureCallInfo): Promise<TOut>;
  /** Phantom generics carrier (never read at runtime). */
  readonly __types?: { input: TIn; output: TOut };
}

export const BRIDGE_REF: unique symbol = Symbol("agent-surface.orpc-ref");

/** oRPC-style typed client: nested records of callable procedures. */
export type AnyClientLeaf = (input: never, options?: unknown) => Promise<unknown>;
export interface ClientTree {
  [key: string]: AnyClientLeaf | ClientTree;
}

export type RefsFor<TClient> = {
  [K in keyof TClient]: TClient[K] extends (input: infer I, ...rest: never[]) => Promise<infer O>
    ? AgentProcedureRef<I & object, O>
    : RefsFor<TClient[K]>;
};

export interface OrpcAgentBridgeOptions<TClient extends object> {
  /** The app's existing typed oRPC client (the user's session transport). */
  client: TClient;
  /** Which procedures orpc-agent exposes — the exposure CEILING (docs/05). */
  manifest: OrpcAgentManifest;
  /** Forward confirmation evidence / metadata into the call context. */
  callContext?: (ctx: ProcedureCallInfo) => Record<string, unknown>;
  /** Escape hatch: map raw server errors to typed payloads. */
  mapServerError?: (
    error: unknown,
  ) => import("@agent-surface/core").AgentCapabilityErrorPayload | undefined;
}

export interface OrpcAgentBridge<TClient extends object> {
  /** Typed refs mirroring the router path — only manifest paths exist. */
  refs: RefsFor<TClient>;
  /** Install via registry.setProcedureExecutor(bridge.executor). */
  executor: AgentProcedureExecutor;
  hasPath(path: string): boolean;
  manifest: OrpcAgentManifest;
}

function walkClient(client: ClientTree, path: string): AnyClientLeaf | undefined {
  let node: ClientTree | AnyClientLeaf = client;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    const next: ClientTree | AnyClientLeaf | undefined = (node as ClientTree)[segment];
    if (next === undefined) return undefined;
    node = next;
  }
  return typeof node === "function" ? node : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function defaultMapServerError(
  error: unknown,
): import("@agent-surface/core").AgentCapabilityErrorPayload | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code ?? error.status;
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === 401 || code === 403) {
    return {
      code: "NOT_AUTHORIZED",
      message: "The server rejected this call as not authorized.",
      retry: "no",
      details: { origin: "server" },
    };
  }
  const data = isRecord(error.data) ? error.data : undefined;
  if (code === "APPROVAL_REQUIRED" || data?.approvalRequired === true) {
    return {
      code: "CONFIRMATION_REQUIRED",
      message:
        "The server requires its own approval for this operation. Wait for approval, then retry.",
      retry: "with-confirmation",
      details: {
        origin: "server",
        ...(typeof data?.approvalId === "string" ? { confirmationId: data.approvalId } : {}),
      },
    };
  }
  return undefined;
}

/**
 * Creates the manifest-gated bridge between the app's oRPC client and the
 * agent surface. The frontend can narrow domain exposure (by not
 * referencing) but can never widen it — the manifest is the ceiling.
 */
export function createOrpcAgentBridge<TClient extends object>(
  options: OrpcAgentBridgeOptions<TClient>,
): OrpcAgentBridge<TClient> {
  const client = options.client as ClientTree;
  const { manifest } = options;
  const mapError = options.mapServerError ?? defaultMapServerError;

  const refs: Record<string, unknown> = {};
  for (const [path, tool] of Object.entries(manifest.tools)) {
    const segments = path.split(".");
    let node = refs;
    for (const segment of segments.slice(0, -1)) {
      node[segment] = node[segment] ?? {};
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1]!;
    const ref: AgentProcedureRef<object, unknown> & { [BRIDGE_REF]: true } = {
      id: `domain:${path}`,
      path,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      effect: tool.effect,
      ...(tool.requiresApproval !== undefined ? { requiresApproval: tool.requiresApproval } : {}),
      [BRIDGE_REF]: true,
      async call(input: object, ctx: ProcedureCallInfo): Promise<unknown> {
        const fn = walkClient(client, path);
        if (!fn) {
          throw new AgentSurfaceError({
            code: "EXECUTION_FAILED",
            message: "The server call failed.",
            retry: "no",
            details: { reason: "transport" },
          });
        }
        return fn(input as never, {
          signal: ctx.signal,
          ...(options.callContext ? { context: options.callContext(ctx) } : {}),
        });
      },
    };
    node[leaf] = ref;
  }

  const executor: AgentProcedureExecutor = {
    paths: Object.keys(manifest.tools),
    async execute({ path, input, info }): Promise<JsonValue> {
      const tool = manifest.tools[path];
      const fn = walkClient(client, path);
      if (!tool || !fn) {
        throw new AgentSurfaceError({
          code: "EXECUTION_FAILED",
          message: "The server call failed.",
          retry: "no",
          details: { reason: "transport" },
        });
      }
      try {
        const output = await fn(input as never, {
          signal: info.signal,
          ...(options.callContext ? { context: options.callContext(info) } : {}),
        });
        return output as JsonValue;
      } catch (error) {
        const mapped = mapError(error) ?? defaultMapServerError(error);
        if (mapped) throw new AgentSurfaceError(mapped, { cause: error });
        // Transport/procedure errors are SANITIZED (docs/05 step 5, docs/07):
        // never pass error.message through to the agent.
        throw new AgentSurfaceError(
          {
            code: "EXECUTION_FAILED",
            message: "The server call failed.",
            retry: isTransient(error) ? "after-delay" : "no",
            details: {
              reason: "transport",
              ...(isTransient(error) ? { transient: true, retryAfterMs: 1000 } : {}),
            },
          },
          { cause: error },
        );
      }
    },
  };

  return {
    refs: refs as RefsFor<TClient>,
    executor,
    hasPath: (path) => path in manifest.tools,
    manifest,
  };
}

function isTransient(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch network failure shape
  return isRecord(error) && error.transient === true;
}

export function isBridgeRef(value: unknown): value is AgentProcedureRef<object, unknown> {
  return isRecord(value) && (value as { [BRIDGE_REF]?: unknown })[BRIDGE_REF] === true;
}
