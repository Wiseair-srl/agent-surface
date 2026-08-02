import {
  encodeWireName,
  randomInvocationId,
  type AgentCapabilityDescriptorUnion,
  type AgentConsumer,
  type AgentSurfaceRegistry,
  type JsonSchema,
  type JsonValue,
  type SnapshotContext,
} from "./core-facade.js";

/* ───────────────────────── adapter contract (docs/09) ───────────────────────── */

export interface AdapterHost {
  registry: AgentSurfaceRegistry;
  consumer: AgentConsumer; // identity this adapter acts as
  /** Adapter-scoped snapshot defaults (scope, budget). */
  snapshotContext?: Omit<SnapshotContext, "consumer">;
}

export interface AgentSurfaceAdapter {
  readonly name: string;
  start(host: AdapterHost): void | Promise<void>;
  stop(): void | Promise<void>;
}

/* ───────────── assumed navigator.modelContext shape (Experimental) ─────────────
 * The WebMCP surface area is unstable (OQ-2); this module encodes the current
 * assumption and absorbs drift so nothing WebMCP-shaped leaks into core.
 */

export interface WebMcpToolInit {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: JsonValue): Promise<WebMcpToolResult>;
}

export interface WebMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface WebMcpModelContext {
  provideContext(context: { tools: WebMcpToolInit[] }): void;
}

export interface CreateWebMcpAdapterOptions {
  snapshotContext?: Omit<SnapshotContext, "consumer">;
  /**
   * Curate presentation before exposing. Execution always remains registry-routed.
   * Return null to skip; undefined to keep defaults.
   */
  exposeCapability?: (
    descriptor: AgentCapabilityDescriptorUnion,
  ) => { description?: string } | null | undefined;
  /** Test seam: defaults to (navigator as any).modelContext. */
  modelContext?: WebMcpModelContext;
}

/**
 * Maps the registry onto `navigator.modelContext`, treating WebMCP strictly
 * as transport/discovery: one wire-named tool per AVAILABLE capability,
 * re-provided on every surface-changed; unavailable capabilities are not
 * registered (WebMCP has no disabled state today — accepted limitation);
 * confirmations stay two-phase; absent modelContext ⇒ start() does nothing.
 */
export function createWebMcpAdapter(options?: CreateWebMcpAdapterOptions): AgentSurfaceAdapter {
  let unsubscribe: (() => void) | undefined;

  return {
    name: "webmcp",

    start(host: AdapterHost): void {
      const modelContext =
        options?.modelContext ??
        (globalThis as { navigator?: { modelContext?: WebMcpModelContext } }).navigator
          ?.modelContext;
      if (!modelContext) return; // feature-detect, never polyfill

      const provide = (): void => {
        const snapshot = host.registry.snapshot({
          consumer: host.consumer,
          ...(options?.snapshotContext ?? host.snapshotContext ?? {}),
          includeUnavailable: false,
        });

        const tools: WebMcpToolInit[] = [];

        const toTool = (
          descriptor: AgentCapabilityDescriptorUnion,
          capabilityId: string,
          registrationId: string,
          inputSchema: JsonSchema,
          description: string,
        ): WebMcpToolInit => ({
          name: encodeWireName(capabilityId),
          description,
          inputSchema,
          execute: async (input: JsonValue): Promise<WebMcpToolResult> => {
            const result = await host.registry.invoke(
              {
                invocationId: randomInvocationId(),
                capabilityId,
                registrationId,
                surfaceVersion: snapshot.surfaceVersion,
                ...(input !== undefined && Object.keys(input as object).length > 0
                  ? { input }
                  : {}),
              },
              { consumer: host.consumer },
            );
            // Capability errors ride in tool CONTENT, never protocol errors
            // (docs/07 adapter mapping): code/retry/details preserved.
            if (result.status === "ok") {
              return {
                content: [{ type: "text", text: JSON.stringify(result.output ?? null) }],
              };
            }
            return {
              content: [{ type: "text", text: JSON.stringify(result.error) }],
              isError: true,
            };
          },
        });

        for (const component of snapshot.components) {
          for (const obs of component.observations) {
            if (!obs.available) continue;
            const curated = options?.exposeCapability?.(obs);
            if (options?.exposeCapability && curated === null) continue;
            tools.push(
              toTool(
                obs,
                obs.capabilityId,
                component.registrationId,
                { type: "object", properties: {}, additionalProperties: false },
                curated?.description ?? `[view · read] ${obs.description}`,
              ),
            );
          }
          for (const act of component.actions) {
            if (!act.available) continue;
            const curated = options?.exposeCapability?.(act);
            if (options?.exposeCapability && curated === null) continue;
            tools.push(
              toTool(
                act,
                act.capabilityId,
                component.registrationId,
                act.inputSchema,
                curated?.description ?? `[view · ${act.effect}] ${act.description}`,
              ),
            );
          }
        }
        for (const proc of snapshot.procedures) {
          if (!proc.available) continue;
          const curated = options?.exposeCapability?.(proc);
          if (options?.exposeCapability && curated === null) continue;
          tools.push(
            toTool(
              proc,
              proc.procedureId,
              proc.registrationId,
              proc.inputSchema,
              curated?.description ??
                `[domain · ${proc.effect}${proc.confirmation === "required" ? " · requires confirmation" : ""}] ${proc.description}`,
            ),
          );
        }

        modelContext.provideContext({ tools });
      };

      provide();
      unsubscribe = host.registry.subscribe((event) => {
        if (event.type === "surface-changed") provide();
      });
    },

    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
