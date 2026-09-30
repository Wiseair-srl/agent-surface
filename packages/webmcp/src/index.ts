import {
  encodeWireName,
  randomInvocationId,
  type AgentCapabilityDescriptorUnion,
  type AgentConsumer,
  type AgentSurfaceRegistry,
  type JsonSchema,
  type JsonValue,
  type PendingConfirmation,
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
 * Targeted revision: see "Targeted WebMCP revision" in docs/09.
 */

export interface WebMcpToolAnnotations {
  /** The tool does not change state; a browser agent may skip its approval prompt. */
  readOnlyHint?: boolean;
}

/** The per-call client WebMCP passes to `execute`. */
export interface WebMcpClient {
  /** Pauses the tool call to run in-page UI; resolves with the callback's value. */
  requestUserInteraction?<T>(callback: () => Promise<T>): Promise<T>;
}

export interface WebMcpToolInit {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: WebMcpToolAnnotations;
  execute(input: JsonValue, client?: WebMcpClient): Promise<WebMcpToolResult>;
}

export interface WebMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface WebMcpModelContext {
  /** Replaces the whole tool set. Fallback when the incremental API is absent. */
  provideContext(context: { tools: WebMcpToolInit[] }): void;
  /** Removes every tool provided through provideContext. */
  clearContext?(): void;
  registerTool?(tool: WebMcpToolInit): unknown;
  unregisterTool?(name: string): void;
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
  /**
   * Opt-in in-page confirmation. When a call returns CONFIRMATION_REQUIRED and
   * the WebMCP client supports `requestUserInteraction`, this host UI runs
   * inside it; the answer resolves the registry's pending confirmation and the
   * call is retried once, so the agent sees one final result. The registry
   * stays the confirmation authority. Absent (or no client support, or the UI
   * throws) ⇒ the call waits for the host's own confirmation UI instead.
   */
  confirm?: (request: PendingConfirmation, client: WebMcpClient) => Promise<boolean> | boolean;
  /** Test seam: defaults to (navigator as any).modelContext. */
  modelContext?: WebMcpModelContext;
}

interface ToolTarget {
  capabilityId: string;
  registrationId: string;
  /** Updated in place when the tool survives a surface change unchanged. */
  surfaceVersion: string;
}

interface ExposedTool {
  tool: WebMcpToolInit;
  target: ToolTarget;
  /** Everything the browser agent sees, plus the registration it routes to. */
  signature: string;
}

interface DesiredTool {
  name: string;
  capabilityId: string;
  registrationId: string;
  inputSchema: JsonSchema;
  description: string;
  readOnly: boolean;
}

const READ_ONLY_EFFECTS: ReadonlySet<string> = new Set(["read", "server-query"]);

/**
 * Maps the registry onto `navigator.modelContext`, treating WebMCP strictly
 * as transport/discovery: one wire-named tool per AVAILABLE capability,
 * reconciled on every surface-changed (incremental registerTool/unregisterTool
 * when the browser supports it, full provideContext otherwise); unavailable
 * capabilities are not registered (WebMCP has no disabled state today —
 * accepted limitation); absent modelContext ⇒ start() does nothing; stop()
 * withdraws every tool and aborts confirmation waits.
 *
 * Confirmations complete within one call: through `confirm` when it applies,
 * otherwise by waiting (bounded by the confirmation TTL) for the host to
 * resolve the pending record. Plain two-phase cannot work on this transport:
 * the tool schema has no slot for a confirmationId, so a retry never carries
 * evidence and each one opens a new confirmation.
 */
export function createWebMcpAdapter(options?: CreateWebMcpAdapterOptions): AgentSurfaceAdapter {
  let session:
    | {
        modelContext: WebMcpModelContext;
        incremental: boolean;
        exposed: Map<string, ExposedTool>;
        unsubscribe: () => void;
        active: boolean;
        waits: Set<AbortController>;
      }
    | undefined;

  return {
    name: "webmcp",

    start(host: AdapterHost): void {
      if (session) return;
      const modelContext =
        options?.modelContext ??
        (globalThis as { navigator?: { modelContext?: WebMcpModelContext } }).navigator
          ?.modelContext;
      if (!modelContext) return; // feature-detect, never polyfill

      const incremental =
        typeof modelContext.registerTool === "function" &&
        typeof modelContext.unregisterTool === "function";
      const state = {
        modelContext,
        incremental,
        exposed: new Map<string, ExposedTool>(),
        unsubscribe: () => {},
        active: true,
        waits: new Set<AbortController>(),
      };

      /** Wait for the host to resolve a pending confirmation; aborted by stop(). */
      const waitForConfirmation = async (confirmationId: string): Promise<void> => {
        const controller = new AbortController();
        state.waits.add(controller);
        try {
          await host.registry.confirmations.waitFor(confirmationId, { signal: controller.signal });
        } finally {
          state.waits.delete(controller);
        }
      };

      const invoke = (target: ToolTarget, invocationId: string, input: JsonValue, confirmationId?: string) =>
        host.registry.invoke(
          {
            invocationId,
            capabilityId: target.capabilityId,
            registrationId: target.registrationId,
            surfaceVersion: target.surfaceVersion,
            // Forwarded as given (like the core toolset): dropping `{}` made
            // zero-argument actions fail INVALID_INPUT. Observations ignore input.
            ...(input !== undefined ? { input } : {}),
            ...(confirmationId !== undefined ? { confirmationId } : {}),
          },
          { consumer: host.consumer },
        );

      const toTool = (desired: DesiredTool, target: ToolTarget): WebMcpToolInit => ({
        name: desired.name,
        description: desired.description,
        inputSchema: desired.inputSchema,
        ...(desired.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        execute: async (input: JsonValue, client?: WebMcpClient): Promise<WebMcpToolResult> => {
          const invocationId = randomInvocationId();
          let result = await invoke(target, invocationId, input);

          const confirmationId =
            result.status === "error" && result.error.code === "CONFIRMATION_REQUIRED"
              ? result.error.details?.confirmationId
              : undefined;
          let resolvedInPage = false;
          if (
            options?.confirm &&
            typeof confirmationId === "string" &&
            typeof client?.requestUserInteraction === "function" &&
            state.active
          ) {
            const pending = host.registry.confirmations
              .pending()
              .find((record) => record.confirmationId === confirmationId);
            if (pending) {
              const confirm = options.confirm;
              let approved: boolean | undefined;
              try {
                approved =
                  (await client.requestUserInteraction(async () => confirm(pending, client))) ===
                  true;
              } catch {
                approved = undefined; // UI failed: leave it pending, fall back to waiting
              }
              // A stop() mid-prompt returns the pending result as-is (docs/09 §9).
              if (approved !== undefined && state.active) {
                host.registry.confirmations.resolve(
                  confirmationId,
                  approved ? { approved: true } : { approved: false, reason: "Declined in page" },
                );
                // Same invocationId + confirmationId (docs/03 D14): the registry
                // decides the outcome, the adapter only relayed the answer.
                result = await invoke(target, invocationId, input, confirmationId);
                resolvedInPage = true;
              }
            }
          }

          // Fallback: wait for the host's own confirmation UI, then retry once.
          // Denial and expiry come back as CONFIRMATION_INVALID, never retried.
          // A stop() before or during the wait returns the pending result as-is.
          if (!resolvedInPage && typeof confirmationId === "string" && state.active) {
            await waitForConfirmation(confirmationId);
            if (state.active) result = await invoke(target, invocationId, input, confirmationId);
          }

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

      const desiredTools = (): { surfaceVersion: string; tools: DesiredTool[] } => {
        const snapshot = host.registry.snapshot({
          consumer: host.consumer,
          ...(options?.snapshotContext ?? host.snapshotContext ?? {}),
          includeUnavailable: false,
        });
        const tools: DesiredTool[] = [];
        const add = (
          descriptor: AgentCapabilityDescriptorUnion,
          capabilityId: string,
          registrationId: string,
          inputSchema: JsonSchema,
          defaultDescription: string,
          readOnly: boolean,
        ): void => {
          if (!descriptor.available) return;
          const curated = options?.exposeCapability?.(descriptor);
          if (options?.exposeCapability && curated === null) return;
          tools.push({
            name: encodeWireName(capabilityId),
            capabilityId,
            registrationId,
            inputSchema,
            description: curated?.description ?? defaultDescription,
            // Derived from the declared kind/effect only; curation cannot widen it.
            readOnly,
          });
        };

        for (const component of snapshot.components) {
          for (const obs of component.observations) {
            add(
              obs,
              obs.capabilityId,
              component.registrationId,
              { type: "object", properties: {}, additionalProperties: false },
              `[view · read] ${obs.description}`,
              true,
            );
          }
          for (const act of component.actions) {
            add(
              act,
              act.capabilityId,
              component.registrationId,
              act.inputSchema,
              `[view · ${act.effect}] ${act.description}`,
              READ_ONLY_EFFECTS.has(act.effect),
            );
          }
        }
        for (const proc of snapshot.procedures) {
          add(
            proc,
            proc.procedureId,
            proc.registrationId,
            proc.inputSchema,
            `[domain · ${proc.effect}${proc.confirmation === "required" ? " · requires confirmation" : ""}] ${proc.description}`,
            READ_ONLY_EFFECTS.has(proc.effect),
          );
        }
        return { surfaceVersion: snapshot.surfaceVersion, tools };
      };

      const reconcile = (): void => {
        if (!state.active) return;
        const { surfaceVersion, tools } = desiredTools();
        const next = new Map<string, ExposedTool>();
        const toRegister: WebMcpToolInit[] = [];

        for (const desired of tools) {
          const signature = JSON.stringify([
            desired.description,
            desired.inputSchema,
            desired.registrationId,
            desired.capabilityId,
            desired.readOnly,
          ]);
          const current = state.exposed.get(desired.name);
          if (current && current.signature === signature) {
            // Unchanged tool: keep the registration, refresh the version it
            // echoes so execute carries the latest projected surfaceVersion.
            current.target.surfaceVersion = surfaceVersion;
            next.set(desired.name, current);
            continue;
          }
          const target: ToolTarget = {
            capabilityId: desired.capabilityId,
            registrationId: desired.registrationId,
            surfaceVersion,
          };
          const tool = toTool(desired, target);
          next.set(desired.name, { tool, target, signature });
          toRegister.push(tool);
        }

        if (state.incremental) {
          for (const [name, current] of state.exposed) {
            const replacement = next.get(name);
            if (replacement !== current) modelContext.unregisterTool!(name);
          }
          for (const tool of toRegister) modelContext.registerTool!(tool);
        } else {
          modelContext.provideContext({ tools: [...next.values()].map((entry) => entry.tool) });
        }
        state.exposed = next;
      };

      session = state;
      reconcile();
      state.unsubscribe = host.registry.subscribe((event) => {
        if (event.type === "surface-changed") reconcile();
      });
    },

    stop(): void {
      const state = session;
      session = undefined;
      if (!state) return; // idempotent
      state.active = false;
      state.unsubscribe();
      for (const controller of state.waits) controller.abort();
      state.waits.clear();
      const { modelContext } = state;
      if (state.incremental) {
        // Withdraw only our tools; other page code may own the rest.
        for (const name of state.exposed.keys()) {
          try {
            modelContext.unregisterTool!(name);
          } catch {
            // Already gone on the browser side; nothing left to release.
          }
        }
      } else if (typeof modelContext.clearContext === "function") {
        modelContext.clearContext();
      } else {
        modelContext.provideContext({ tools: [] });
      }
      state.exposed.clear();
    },
  };
}
