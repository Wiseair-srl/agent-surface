import { afterEach, describe, expect, it, vi } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  observation,
  type AgentProcedureExecutor,
  type AgentSurfaceRegistry,
  type JsonValue,
} from "@agent-surface/core";
import {
  SelectRowsSchema,
  devicesTableDefinition,
  disableBinding,
  makeDevicesState,
} from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const anyObject = fromJsonSchema({ type: "object", additionalProperties: true });

function errorOf(result: Awaited<ReturnType<AgentSurfaceRegistry["invoke"]>>): {
  code: string;
  message: string;
  details?: Record<string, JsonValue>;
  retry: string;
} {
  if (result.status !== "error") throw new Error(`expected error, got ok`);
  return result.error;
}

describe("resolution (pipeline phase 2)", () => {
  it("CAPABILITY_NOT_FOUND for never-registered ids, retry after-refresh", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const result = await registry.invoke({ capabilityId: "view:ghost.panel.doThing" });
    expect(errorOf(result).code).toBe("CAPABILITY_NOT_FOUND");
    expect(errorOf(result).retry).toBe("after-refresh");
  });

  it("COMPONENT_UNMOUNTED via tombstone after unregistration", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    handle.unregister();
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1"] },
    });
    expect(errorOf(result).code).toBe("COMPONENT_UNMOUNTED");
    expect(errorOf(result).details?.phase).toBe("resolve");
  });

  it("STALE_CAPABILITY(registration-replaced) when a live replacement exists", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const h1 = registry.register(devicesTableDefinition(makeDevicesState()));
    const staleId = h1.registrationId;
    h1.unregister();
    const h2 = registry.register(devicesTableDefinition(makeDevicesState()));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1"] },
      registrationId: staleId,
    });
    const error = errorOf(result);
    expect(error.code).toBe("STALE_CAPABILITY");
    expect(error.details?.reason).toBe("registration-replaced");
    expect(error.details?.liveRegistrationId).toBe(h2.registrationId);
  });

  it("STALE_CAPABILITY(surface-reloaded) for a registrationId from another page load", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1"] },
      registrationId: "reg_from_previous_page_load",
    });
    expect(errorOf(result).details?.reason).toBe("surface-reloaded");
  });

  it("AMBIGUOUS_INSTANCE lists live instances, retry with-changes", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "main" }));
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "comparison" }));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1"] },
    });
    const error = errorOf(result);
    expect(error.code).toBe("AMBIGUOUS_INSTANCE");
    expect(error.retry).toBe("with-changes");
    const instances = error.details?.instances as Array<{ instanceId: string }>;
    expect(instances.map((i) => i.instanceId).sort()).toEqual(["comparison", "main"]);
  });

  it("explicit instanceId resolves among multiple instances", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const stateMain = makeDevicesState();
    registry.register(devicesTableDefinition(stateMain, { instanceId: "main" }));
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "comparison" }));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      instanceId: "main",
      input: { ids: ["d1"] },
    });
    expect(result.status).toBe("ok");
    expect(stateMain.selectedIds).toEqual(["d1"]);
  });
});

describe("availability (phase 3) and input (phase 5)", () => {
  it("CAPABILITY_NOT_AVAILABLE carries the unavailableReason", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.clearSelection",
      input: {},
    });
    const error = errorOf(result);
    expect(error.code).toBe("CAPABILITY_NOT_AVAILABLE");
    expect(error.details?.reason).toBe("No rows are selected");
  });

  it("availability is re-evaluated at invocation time, not trusted from discovery", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    registry.register(devicesTableDefinition(state));
    // Discovered available…
    expect(
      registry.snapshot().components[0]!.actions.find((a) => a.name === "clearSelection")
        ?.available,
    ).toBe(true);
    // …state changes between discovery and invocation…
    state.selectedIds = [];
    const result = await registry.invoke({
      capabilityId: "view:devices.table.clearSelection",
      input: {},
    });
    expect(errorOf(result).code).toBe("CAPABILITY_NOT_AVAILABLE");
  });

  it("INVALID_INPUT carries structured issues", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: [] },
    });
    const error = errorOf(result);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.retry).toBe("with-changes");
    const issues = error.details?.issues as Array<{ path: string; message: string }>;
    expect(issues.some((i) => i.path === "ids")).toBe(true);
  });

  it("PRECONDITION_FAILED passes the author's message and details through", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const result = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["nope"] },
    });
    const error = errorOf(result);
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.details?.unknown).toEqual(["nope"]);
  });

  it("parsed (defaulted) input reaches the handler", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const seen: JsonValue[] = [];
    registry.register(
      defineAgentComponent({
        type: "widget.echo",
        description: "echo",
        actions: {
          run: action({
            description: "echo input",
            input: SelectRowsSchema,
            output: anyObject,
            effect: "local-state",
            execute: (input) => {
              seen.push(input as JsonValue);
              return input as Record<string, JsonValue>;
            },
          }),
        },
      }),
    );
    const result = await registry.invoke({
      capabilityId: "view:widget.echo.run",
      input: { ids: ["d1"], mode: "add" },
    });
    expect(result.status).toBe("ok");
    expect(seen[0]).toEqual({ ids: ["d1"], mode: "add" });
  });
});

describe("observation invocations", () => {
  it("run through the same API, skip confirmation and queueing", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));
    const result = await registry.invoke({ capabilityId: "view:devices.table.readState" });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.output).toMatchObject({ selectedIds: [] });
  });

  it("observations run concurrently while actions serialize", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    let concurrent = 0;
    let maxConcurrent = 0;
    registry.register(
      defineAgentComponent({
        type: "widget.par",
        description: "parallel obs",
        observations: {
          slow: observation({
            description: "slow read",
            output: anyObject,
            read: async () => {
              concurrent += 1;
              maxConcurrent = Math.max(maxConcurrent, concurrent);
              await new Promise((r) => setTimeout(r, 5));
              concurrent -= 1;
              return {};
            },
          }),
        },
      }),
    );
    await Promise.all([
      registry.invoke({ capabilityId: "view:widget.par.slow" }),
      registry.invoke({ capabilityId: "view:widget.par.slow" }),
      registry.invoke({ capabilityId: "view:widget.par.slow" }),
    ]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});

describe("concurrency: per-instance FIFO serialization + bounded queue (D13)", () => {
  it("serializes actions per instance and fails overflow with RATE_LIMITED(queue-full)", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const order: number[] = [];
    let release: (() => void) | undefined;
    registry.register(
      defineAgentComponent({
        type: "widget.serial",
        description: "serialized",
        actions: {
          run: action({
            description: "runs",
            input: fromJsonSchema<{ n: number }>({
              type: "object",
              properties: { n: { type: "number" } },
              required: ["n"],
            }),
            effect: "local-state",
            execute: async ({ n }) => {
              order.push(n);
              if (n === 1) {
                await new Promise<void>((r) => {
                  release = r;
                });
              }
            },
          }),
        },
      }),
    );

    const first = registry.invoke({ capabilityId: "view:widget.serial.run", input: { n: 1 } });
    const second = registry.invoke({ capabilityId: "view:widget.serial.run", input: { n: 2 } });
    const third = registry.invoke({ capabilityId: "view:widget.serial.run", input: { n: 3 } });
    const overflow = await registry.invoke({
      capabilityId: "view:widget.serial.run",
      input: { n: 4 },
    });

    const overflowError = errorOf(overflow);
    expect(overflowError.code).toBe("RATE_LIMITED");
    expect(overflowError.details?.reason).toBe("queue-full");
    expect(typeof overflowError.details?.retryAfterMs).toBe("number");

    expect(order).toEqual([1]); // 2 and 3 are queued, not started
    release?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]); // FIFO
  });
});

describe("idempotency / dedupe (D14)", () => {
  it("same invocationId: handler executes once, both calls get the identical result", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    let calls = 0;
    registry.register(
      defineAgentComponent({
        type: "widget.dedupe",
        description: "dedupe",
        actions: {
          run: action({
            description: "counts",
            input: anyObject,
            output: anyObject,
            effect: "local-state",
            execute: async () => {
              calls += 1;
              await new Promise((r) => setTimeout(r, 1));
              return { calls };
            },
          }),
        },
      }),
    );
    const [a, b] = await Promise.all([
      registry.invoke({ capabilityId: "view:widget.dedupe.run", input: {}, invocationId: "inv_x" }),
      registry.invoke({ capabilityId: "view:widget.dedupe.run", input: {}, invocationId: "inv_x" }),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    // Terminal cache: a later retry returns the cached result verbatim.
    const c = await registry.invoke({
      capabilityId: "view:widget.dedupe.run",
      input: {},
      invocationId: "inv_x",
    });
    expect(c).toEqual(a);
    expect(calls).toBe(1);
  });
});

describe("timeouts, cancellation, unmount mid-flight (D15/D16)", () => {
  it("TIMEOUT aborts the signal; late settlement is audited, not delivered", async () => {
    vi.useFakeTimers();
    const { memoryAuditSink } = await import("@agent-surface/core");
    const sink = memoryAuditSink();
    const registry = createAgentSurfaceRegistry({ environment: "test", audit: sink });
    let abortSeen = false;
    let resolveLate: (() => void) | undefined;
    registry.register(
      defineAgentComponent({
        type: "widget.slow",
        description: "slow",
        actions: {
          hang: action({
            description: "hangs",
            input: anyObject,
            effect: "local-state",
            timeoutMs: 50,
            execute: (_input, ctx) => {
              ctx.signal.addEventListener("abort", () => {
                abortSeen = true;
              });
              return new Promise<void>((r) => {
                resolveLate = r;
              });
            },
          }),
        },
      }),
    );
    const pending = registry.invoke({ capabilityId: "view:widget.slow.hang", input: {} });
    await vi.advanceTimersByTimeAsync(60);
    const result = await pending;
    const error = errorOf(result);
    expect(error.code).toBe("TIMEOUT");
    expect(error.details).toMatchObject({ timeoutMs: 50, idempotent: false });
    expect(error.retry).toBe("no"); // non-idempotent ⇒ verify before retrying
    expect(abortSeen).toBe(true);

    // Late settlement is ignored (result already terminal) and audited.
    resolveLate?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(result);
    expect(sink.events().some((e) => e.type === "late-settlement")).toBe(true);
  });

  it("external AbortSignal ⇒ CANCELLED", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      defineAgentComponent({
        type: "widget.cancellable",
        description: "cancellable",
        actions: {
          hang: action({
            description: "hangs",
            input: anyObject,
            effect: "local-state",
            execute: () => new Promise<void>(() => {}),
          }),
        },
      }),
    );
    const controller = new AbortController();
    const pending = registry.invoke(
      { capabilityId: "view:widget.cancellable.hang", input: {} },
      { signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(errorOf(result).code).toBe("CANCELLED");
  });

  it("unmount mid-flight ⇒ COMPONENT_UNMOUNTED {phase: mid-flight}", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(
      defineAgentComponent({
        type: "widget.unmounting",
        description: "unmounts mid-action",
        actions: {
          hang: action({
            description: "hangs",
            input: anyObject,
            effect: "local-state",
            execute: () => new Promise<void>(() => {}),
          }),
        },
      }),
    );
    const pending = registry.invoke({ capabilityId: "view:widget.unmounting.hang", input: {} });
    await new Promise((r) => setTimeout(r, 0)); // let the pipeline reach execution
    handle.unregister();
    const result = await pending;
    const error = errorOf(result);
    expect(error.code).toBe("COMPONENT_UNMOUNTED");
    expect(error.details?.phase).toBe("mid-flight");
  });

  it("navigation that unmounts its own component: sync handler completion wins (D16)", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    let done = false;
    // eslint-disable-next-line prefer-const
    let handle: ReturnType<typeof registry.register> | undefined;
    handle = registry.register(
      defineAgentComponent({
        type: "widget.sync",
        description: "sync navigation-ish action",
        actions: {
          go: action({
            description: "completes synchronously, then the route unmounts us",
            input: anyObject,
            effect: "navigation",
            execute: () => {
              done = true;
              queueMicrotask(() => handle?.unregister()); // React-like async unmount
            },
          }),
        },
      }),
    );
    const result = await registry.invoke({ capabilityId: "view:widget.sync.go", input: {} });
    expect(done).toBe(true);
    expect(result.status).toBe("ok"); // handler finished before the unmount
    expect(result.surfaceChanged).toBe(true); // …and the agent is told to re-discover
  });
});

describe("settle (phase 9)", () => {
  it("EXECUTION_FAILED(handler-error) sanitizes the message", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      defineAgentComponent({
        type: "widget.thrower",
        description: "throws",
        actions: {
          boom: action({
            description: "throws",
            input: anyObject,
            effect: "local-state",
            execute: () => {
              throw new Error("SELECT * FROM secrets WHERE internal_url='https://internal'");
            },
          }),
        },
      }),
    );
    const result = await registry.invoke({ capabilityId: "view:widget.thrower.boom", input: {} });
    const error = errorOf(result);
    expect(error.code).toBe("EXECUTION_FAILED");
    expect(error.details?.reason).toBe("handler-error");
    expect(error.message).not.toContain("SELECT");
    expect(error.message).not.toContain("internal");
  });

  it("EXECUTION_FAILED(output-too-large) — truncation is never silent", async () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      limits: { maxOutputBytes: 64 },
    });
    registry.register(
      defineAgentComponent({
        type: "widget.big",
        description: "big output",
        observations: {
          dump: observation({
            description: "dumps",
            output: anyObject,
            read: () => ({ blob: "x".repeat(500) }),
          }),
        },
      }),
    );
    const result = await registry.invoke({ capabilityId: "view:widget.big.dump" });
    expect(errorOf(result).details?.reason).toBe("output-too-large");
  });

  it("EXECUTION_FAILED(output-invalid) when the declared output schema rejects", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "production" });
    registry.register(
      defineAgentComponent({
        type: "widget.badout",
        description: "bad output",
        actions: {
          run: action({
            description: "returns wrong shape",
            input: anyObject,
            output: fromJsonSchema({
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            }),
            effect: "local-state",
            execute: () => ({ ok: "yes" }) as never,
          }),
        },
      }),
    );
    const result = await registry.invoke({ capabilityId: "view:widget.badout.run", input: {} });
    expect(errorOf(result).details?.reason).toBe("output-invalid");
  });

  it("non-JsonValue outputs throw in development and settle EXECUTION_FAILED in production", async () => {
    const make = (environment: "test" | "production"): AgentSurfaceRegistry => {
      const registry = createAgentSurfaceRegistry({ environment });
      registry.register(
        defineAgentComponent({
          type: "widget.date",
          description: "returns a Date",
          observations: {
            now: observation({
              description: "returns a Date object (a defect)",
              output: anyObject,
              read: () => new Date() as never,
            }),
          },
        }),
      );
      return registry;
    };
    await expect(make("test").invoke({ capabilityId: "view:widget.date.now" })).rejects.toThrow(
      /JsonValue/,
    );
    const prodResult = await make("production").invoke({ capabilityId: "view:widget.date.now" });
    expect(errorOf(prodResult).details?.reason).toBe("output-invalid");
  });

  it("emits invocation-started before invocation-settled with durationMs", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const events: string[] = [];
    registry.subscribe((e) => {
      if (e.type === "invocation-started" || e.type === "invocation-settled") events.push(e.type);
    });
    await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1"] },
    });
    expect(events).toEqual(["invocation-started", "invocation-settled"]);
  });
});

describe("procedures (docs/05 execution flow)", () => {
  function procedureSetup(opts?: Parameters<typeof disableBinding>[1]): {
    registry: AgentSurfaceRegistry;
    state: ReturnType<typeof makeDevicesState>;
    executorCalls: Array<{ path: string; input: JsonValue }>;
  } {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const executorCalls: Array<{ path: string; input: JsonValue }> = [];
    const executor: AgentProcedureExecutor = {
      paths: ["devices.disable"],
      async execute({ path, input }) {
        executorCalls.push({ path, input });
        return { disabled: Array.isArray((input as { deviceIds?: unknown[] }).deviceIds) ? (input as { deviceIds: unknown[] }).deviceIds.length : 0 };
      },
    };
    registry.setProcedureExecutor(executor);
    const state = makeDevicesState();
    state.selectedIds = ["d1", "d2"];
    registry.register(
      devicesTableDefinition(state, { procedures: [disableBinding(state, opts)] }),
    );
    return { registry, state, executorCalls };
  }

  it("locked bound fields cannot be supplied: INVALID_INPUT {lockedFields}", async () => {
    const { registry } = procedureSetup();
    const result = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: { deviceIds: ["victim"] },
    });
    const error = errorOf(result);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.details?.lockedFields).toEqual(["deviceIds"]);
  });

  it("bind() runs at execution time and the executor receives merged validated input", async () => {
    const { registry, state, executorCalls } = procedureSetup();
    // Confirmation first (destructive floor), then approve + retry.
    const first = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      invocationId: "inv_disable",
    });
    const confirmationId = errorOf(first).details?.confirmationId as string;
    state.selectedIds = ["d1", "d2"]; // unchanged; retained for clarity
    registry.confirmations.resolve(confirmationId, { approved: true });
    const second = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      invocationId: "inv_disable",
      confirmationId,
    });
    expect(second.status).toBe("ok");
    expect(second.status === "ok" && second.output).toEqual({ disabled: 2 });
    expect(executorCalls).toEqual([
      { path: "devices.disable", input: { deviceIds: ["d1", "d2"] } },
    ]);
  });

  it("binding evaluation failure ⇒ PRECONDITION_FAILED {reason: binding-failed}", async () => {
    const { registry } = procedureSetup({
      bind: () => {
        throw new Error("ui state exploded");
      },
    });
    const result = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const error = errorOf(result);
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.details?.reason).toBe("binding-failed");
    expect(error.retry).toBe("after-refresh");
  });

  it("unavailable while when() is false, with the binding's reason", async () => {
    const { registry, state } = procedureSetup();
    state.selectedIds = [];
    const result = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const error = errorOf(result);
    expect(error.code).toBe("CAPABILITY_NOT_AVAILABLE");
    expect(error.details?.reason).toBe("Select at least one device first");
  });

  it("destructive + surfaceVersion mismatch ⇒ STALE_CAPABILITY(surface-version-mismatch)", async () => {
    const { registry } = procedureSetup();
    const result = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      surfaceVersion: "999",
    });
    expect(errorOf(result).details?.reason).toBe("surface-version-mismatch");
  });

  it("stale surfaceVersion on non-dangerous effects still proceeds", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.list"],
      execute: async () => ({ items: [] }),
    });
    const state = makeDevicesState();
    registry.register(
      devicesTableDefinition(state, {
        procedures: [
          {
            kind: "procedure-binding",
            ref: {
              id: "domain:devices.list",
              path: "devices.list",
              description: "List devices",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              effect: "server-query",
            },
            config: {},
            boundKeys: [],
            lockedKeys: [],
            reducedInputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
    );
    const result = await registry.invoke({
      capabilityId: "domain:devices.list",
      input: {},
      surfaceVersion: "999",
    });
    expect(result.status).toBe("ok");
  });

  it("executor AgentSurfaceError payloads pass through (server authz)", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      async execute() {
        const { AgentSurfaceError } = await import("@agent-surface/core");
        throw new AgentSurfaceError({
          code: "NOT_AUTHORIZED",
          message: "The server rejected this call as not authorized.",
          retry: "no",
          details: { origin: "server" },
        });
      },
    });
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    registry.register(
      devicesTableDefinition(state, {
        procedures: [disableBinding(state, { effect: "server-mutation" })],
      }),
    );
    const result = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const error = errorOf(result);
    expect(error.code).toBe("NOT_AUTHORIZED");
    expect(error.details?.origin).toBe("server");
  });
});
