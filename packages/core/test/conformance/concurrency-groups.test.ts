/**
 * Conformance: configurable action/procedure concurrency (D25, directive §3.5).
 * Requirement: AS-CONC-001. Deterministic — every handler is gated, nothing
 * depends on timers.
 */
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  type AgentComponentDefinition,
  type AgentConcurrency,
  type AgentInvocationResult,
  type AgentSurfaceRegistry,
} from "@agent-surface/core";
import { disableBinding, makeDevicesState } from "../helpers.js";

const EmptyInput = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/** A capability whose handler blocks until released, counting entries. */
function gate() {
  const releases: Array<() => void> = [];
  let entered = 0;
  const run = async (): Promise<void> => {
    entered += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
  };
  return {
    run,
    get entered() {
      return entered;
    },
    releaseAll(): void {
      for (const release of releases.splice(0)) release();
    },
  };
}

function widget(
  gates: Record<string, () => Promise<void>>,
  concurrency?: Record<string, AgentConcurrency>,
): AgentComponentDefinition {
  const actions: AgentComponentDefinition["actions"] = {};
  for (const [name, run] of Object.entries(gates)) {
    actions[name] = action({
      description: `gated action ${name}`,
      input: EmptyInput,
      effect: "local-state",
      execute: run,
      ...(concurrency?.[name] ? { concurrency: concurrency[name] } : {}),
    });
  }
  return { type: "conc.widget", description: "concurrency fixture", actions };
}

let seq = 0;
function invoke(registry: AgentSurfaceRegistry, name: string): Promise<AgentInvocationResult> {
  return registry.invoke(
    { invocationId: `inv_${(seq += 1)}`, capabilityId: `view:conc.widget.${name}`, input: {} },
    { consumer: { id: "test", kind: "embedded" } },
  );
}

/** Let queued admissions settle without leaning on timers. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("concurrency groups (AS-CONC-001, D25)", () => {
  it("defaults to per-instance serialization across different capabilities", async () => {
    const a = gate();
    const b = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(widget({ a: a.run, b: b.run }));

    const first = invoke(registry, "a");
    const second = invoke(registry, "b");
    await settle();

    // Default {mode:"instance"}: b waits behind a even though it is a
    // different capability. This is the safe default, unchanged from D13.
    expect(a.entered).toBe(1);
    expect(b.entered).toBe(0);

    a.releaseAll();
    await settle();
    expect(b.entered).toBe(1);
    b.releaseAll();
    await Promise.all([first, second]);
  });

  it('mode "capability" runs distinct capabilities in parallel, same-capability serially', async () => {
    const a = gate();
    const b = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      widget({ a: a.run, b: b.run }, { a: { mode: "capability" }, b: { mode: "capability" } }),
    );

    const running = [invoke(registry, "a"), invoke(registry, "b"), invoke(registry, "a")];
    await settle();

    expect(a.entered).toBe(1); // the second `a` queues behind the first
    expect(b.entered).toBe(1); // `b` is a separate group and runs immediately

    a.releaseAll();
    await settle();
    expect(a.entered).toBe(2);
    a.releaseAll();
    b.releaseAll();
    await Promise.all(running);
  });

  it('mode "key" shares one queue across capabilities that contend for a resource', async () => {
    const a = gate();
    const b = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      widget(
        { a: a.run, b: b.run },
        { a: { mode: "key", key: "export" }, b: { mode: "key", key: "export" } },
      ),
    );

    const running = [invoke(registry, "a"), invoke(registry, "b")];
    await settle();
    expect(a.entered).toBe(1);
    expect(b.entered).toBe(0);

    a.releaseAll();
    await settle();
    expect(b.entered).toBe(1);
    b.releaseAll();
    await Promise.all(running);
  });

  it('mode "parallel" admits exactly `max` at once', async () => {
    const a = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      widget({ a: a.run }, { a: { mode: "parallel", max: 2, queueDepth: 4 } }),
    );

    const running = [
      invoke(registry, "a"),
      invoke(registry, "a"),
      invoke(registry, "a"),
      invoke(registry, "a"),
    ];
    await settle();
    expect(a.entered).toBe(2);

    a.releaseAll();
    await settle();
    expect(a.entered).toBe(4);
    a.releaseAll();
    await Promise.all(running);
  });

  it("queue depth is per group and overflow is RATE_LIMITED, not a silent drop", async () => {
    const a = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(widget({ a: a.run }, { a: { mode: "capability", queueDepth: 1 } }));

    const first = invoke(registry, "a"); // running
    const queued = invoke(registry, "a"); // fills the depth-1 queue
    await settle();
    const overflow = await invoke(registry, "a");

    expect(overflow.status).toBe("error");
    expect(overflow.status === "error" && overflow.error.code).toBe("RATE_LIMITED");
    expect(overflow.status === "error" && overflow.error.details?.reason).toBe("queue-full");
    expect(overflow.status === "error" && overflow.error.retry).toBe("after-delay");

    a.releaseAll();
    await settle();
    a.releaseAll();
    await Promise.all([first, queued]);
  });

  it("queue wait is measured and reported separately from execution", async () => {
    const a = gate();
    const events: Array<{ queueWaitMs?: number; executionMs?: number }> = [];
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      audit: {
        record(event) {
          if (event.type === "invocation-settled") {
            events.push({ queueWaitMs: event.queueWaitMs, executionMs: event.executionMs });
          }
        },
      },
    });
    registry.register(widget({ a: a.run }));

    const first = invoke(registry, "a");
    const second = invoke(registry, "a");
    await settle();
    a.releaseAll();
    await settle();
    a.releaseAll();
    await Promise.all([first, second]);

    expect(events).toHaveLength(2);
    // Both numbers exist and are reported separately — a queued invocation's
    // wait must not be billed as execution time (§7.1).
    expect(events.every((t) => typeof t.queueWaitMs === "number")).toBe(true);
    expect(events.every((t) => typeof t.executionMs === "number")).toBe(true);
  });

  it("a settled group leaves no reservation behind (bounded by contention, not history)", async () => {
    const a = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(widget({ a: a.run }, { a: { mode: "capability", queueDepth: 0 } }));

    // Depth 0: any leaked `running` count from a previous cycle would make the
    // next call overflow instead of admitting. Ten cycles, all must admit.
    for (let i = 0; i < 10; i++) {
      const call = invoke(registry, "a");
      await settle();
      expect(a.entered).toBe(i + 1);
      a.releaseAll();
      expect((await call).status).toBe("ok");
    }
  });

  it("a rejected overflow reserves nothing", async () => {
    const a = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(widget({ a: a.run }, { a: { mode: "capability", queueDepth: 0 } }));

    const first = invoke(registry, "a");
    await settle();
    const rejected = await invoke(registry, "a");
    expect(rejected.status === "error" && rejected.error.code).toBe("RATE_LIMITED");

    a.releaseAll();
    expect((await first).status).toBe("ok");

    // The rejection must not have left a phantom slot: the group is free again.
    const after = invoke(registry, "a");
    await settle();
    expect(a.entered).toBe(2);
    a.releaseAll();
    expect((await after).status).toBe("ok");
  });

  it("procedure references default to one group per procedure identity", async () => {
    const executor = gate();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      async execute() {
        await executor.run();
        return { disabled: 1 };
      },
    });
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const viewGate = gate();
    registry.register({
      type: "conc.widget",
      description: "concurrency fixture",
      actions: {
        a: action({
          description: "gated action a",
          input: EmptyInput,
          effect: "local-state",
          execute: viewGate.run,
        }),
      },
      // server-query: no confirmation gate, so the test isolates admission.
      procedures: [disableBinding(state, { effect: "server-query" })],
    });

    const call = (id: string): Promise<AgentInvocationResult> =>
      registry.invoke(
        { invocationId: id, capabilityId: "domain:devices.disable", input: { reason: "x" } },
        { consumer: { id: "test", kind: "embedded" } },
      );

    const running = [call("p1"), call("p2"), invoke(registry, "a")];
    await settle();

    // Repeat calls of the same procedure serialize…
    expect(executor.entered).toBe(1);
    // …but a view action on the same component is a different group and is
    // never blocked by an in-flight domain call.
    expect(viewGate.entered).toBe(1);

    executor.releaseAll();
    await settle();
    expect(executor.entered).toBe(2);
    executor.releaseAll();
    viewGate.releaseAll();
    await Promise.all(running);
  });
});

describe("concurrency definition validation (AS-CONC-001)", () => {
  const bad = (concurrency: unknown): (() => void) => {
    return () => {
      const registry = createAgentSurfaceRegistry({ environment: "test" });
      registry.register(
        widget({ a: gate().run }, { a: concurrency as AgentConcurrency }),
      );
    };
  };

  it("rejects unbounded parallelism", () => {
    expect(bad({ mode: "parallel" })).toThrow(/integer max/);
    expect(bad({ mode: "parallel", max: 0 })).toThrow(/integer max/);
    expect(bad({ mode: "parallel", max: 1.5 })).toThrow(/integer max/);
  });

  it("rejects a keyless key group and unknown modes", () => {
    expect(bad({ mode: "key" })).toThrow(/non-empty key/);
    expect(bad({ mode: "key", key: "" })).toThrow(/non-empty key/);
    expect(bad({ mode: "sequential" })).toThrow(/invalid concurrency mode/);
  });

  it("rejects a negative queue depth", () => {
    expect(bad({ mode: "instance", queueDepth: -1 })).toThrow(/non-negative integer/);
  });
});
