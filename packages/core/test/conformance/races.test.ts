/**
 * The named race tests the spec obliges to exist (directive §6.3). Some
 * overlap other suites — these exist BY NAME, deterministically.
 * Requirements: AS-CONC-010 (unmount races), AS-CONC-011 (timeout/late
 * settlement), AS-CONC-012 (external cancellation), AS-LIFE-005 (staleness
 * + strict-mode symmetry), AS-STALE-002 (version gate on destructive),
 * AS-EVT-001 (non-reentrant dispatch), AS-BOUND-001 (tombstone TTL/LRU),
 * AS-BOUND-002 (dedupe LRU/TTL).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  memoryAuditSink,
  type AgentComponentDefinition,
  type AgentSurfaceEvent,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "../helpers.js";

const EmptyInput = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

function deferredAction() {
  let release!: () => void;
  let executions = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const definition: AgentComponentDefinition = {
    type: "races.widget",
    description: "deterministic race fixture",
    actions: {
      slow: action({
        description: "resolves when released",
        input: EmptyInput,
        effect: "local-state",
        execute: async () => {
          executions += 1;
          await gate;
        },
      }),
      fast: action({
        description: "resolves immediately",
        input: EmptyInput,
        effect: "local-state",
        execute: () => {
          executions += 1;
        },
      }),
    },
  };
  return { definition, release, executions: () => executions };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("unmount races (D16)", () => {
  it("unmount-before-execute", async () => {
    // A queued action whose owner unmounts before it is dispatched never runs.
    const fixture = deferredAction();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(fixture.definition);
    const running = registry.invoke({ capabilityId: "view:races.widget.slow", input: {} });
    const queued = registry.invoke({ capabilityId: "view:races.widget.fast", input: {} });
    await Promise.resolve();
    handle.unregister();
    fixture.release();
    const [r1, r2] = await Promise.all([running, queued]);
    expect(r1.status === "error" && r1.error.code).toBe("COMPONENT_UNMOUNTED");
    expect(r2.status === "error" && r2.error.code).toBe("COMPONENT_UNMOUNTED");
    expect(fixture.executions()).toBe(1); // the queued handler never executed
  });

  it("unmount-during-execute-handler-wins", async () => {
    // The handler settles first; a later unregister cannot rewrite the result.
    const fixture = deferredAction();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(fixture.definition);
    const pending = registry.invoke({ capabilityId: "view:races.widget.slow", input: {} });
    fixture.release();
    const result = await pending;
    handle.unregister();
    expect(result.status).toBe("ok");
  });

  it("unmount-during-execute-unmount-wins", async () => {
    // The handler is still pending when the owner unmounts: COMPONENT_UNMOUNTED
    // settles, and the handler's eventual resolution is logged as late.
    const sink = memoryAuditSink();
    const fixture = deferredAction();
    const registry = createAgentSurfaceRegistry({ environment: "test", audit: sink });
    const handle = registry.register(fixture.definition);
    const pending = registry.invoke({ capabilityId: "view:races.widget.slow", input: {} });
    await Promise.resolve();
    handle.unregister();
    const result = await pending;
    expect(result.status === "error" && result.error.code).toBe("COMPONENT_UNMOUNTED");
    expect(result.status === "error" && result.error.details?.phase).toBe("mid-flight");
    fixture.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.events().some((e) => e.type === "late-settlement")).toBe(true);
  });
});

describe("timeout and cancellation (D15)", () => {
  it("timeout-with-late-resolution", async () => {
    vi.useFakeTimers();
    const sink = memoryAuditSink();
    const registry = createAgentSurfaceRegistry({ environment: "test", audit: sink });
    registry.register({
      type: "races.timer",
      description: "slow handler",
      actions: {
        slow: action({
          description: "resolves after 20 s",
          input: EmptyInput,
          effect: "local-state",
          timeoutMs: 10_000,
          execute: () => new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
        }),
      },
    });
    const pending = registry.invoke({ capabilityId: "view:races.timer.slow", input: {} });
    await vi.advanceTimersByTimeAsync(10_001);
    const result = await pending;
    expect(result.status === "error" && result.error.code).toBe("TIMEOUT");
    expect(sink.events().some((e) => e.type === "late-settlement")).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); // the late resolution arrives
    expect(sink.events().some((e) => e.type === "late-settlement")).toBe(true);
  });

  it("external-cancel-before-queue-entry", async () => {
    const fixture = deferredAction();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(fixture.definition);
    const controller = new AbortController();
    controller.abort(); // aborted before the invocation ever queues
    const result = await registry.invoke(
      { capabilityId: "view:races.widget.fast", input: {} },
      { signal: controller.signal },
    );
    expect(result.status === "error" && result.error.code).toBe("CANCELLED");
    expect(fixture.executions()).toBe(0);
  });

  it("external-cancel-while-queued", async () => {
    const fixture = deferredAction();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(fixture.definition);
    const controller = new AbortController();
    const running = registry.invoke({ capabilityId: "view:races.widget.slow", input: {} });
    const queued = registry.invoke(
      { capabilityId: "view:races.widget.fast", input: {} },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort(); // cancelled while waiting for the action slot
    fixture.release();
    const result = await queued;
    expect(result.status === "error" && result.error.code).toBe("CANCELLED");
    expect(fixture.executions()).toBe(1); // the queued handler never ran
    expect((await running).status).toBe("ok");
  });
});

describe("staleness and lifecycle symmetry", () => {
  it("surface-version-changes-before-destructive-call", async () => {
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({ paths: ["devices.disable"], execute: async () => ({ disabled: 1 }) });
    registry.register({
      type: "devices.toolbar",
      description: "toolbar",
      procedures: [disableBinding(state)],
    });
    const staleVersion = registry.getVersion();
    registry.register(devicesTableDefinition(makeDevicesState())); // version moves
    const result = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      surfaceVersion: staleVersion,
    });
    expect(result.status === "error" && result.error.code).toBe("STALE_CAPABILITY");
    expect(result.status === "error" && result.error.details?.reason).toBe(
      "surface-version-mismatch",
    );
  });

  it("listener-mutates-registry-without-reentrant-dispatch", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const order: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    let seeded = false;
    registry.subscribe((event: AgentSurfaceEvent) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      order.push(event.type);
      if (event.type === "component-registered" && !seeded) {
        seeded = true;
        // A nested mutation from inside a listener MUST be queued, never
        // dispatched re-entrantly (D17).
        registry.register({ type: "races.nested", description: "nested" });
      }
      depth -= 1;
    });
    registry.register(deferredAction().definition);
    await Promise.resolve();
    expect(maxDepth).toBe(1); // never re-entered
    const types = registry.snapshot().components.map((c) => c.type);
    expect(types).toContain("races.widget");
    expect(types).toContain("races.nested");
  });

  it("strict-mode-register-cleanup-register", async () => {
    // Mount → unmount → mount: two distinct registrationIds; the dead one is
    // precisely reported as replaced; the live one works.
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const fixture1 = deferredAction();
    const first = registry.register(fixture1.definition);
    first.unregister();
    const fixture2 = deferredAction();
    const second = registry.register(fixture2.definition);
    expect(second.registrationId).not.toBe(first.registrationId);

    const staleCall = await registry.invoke({
      capabilityId: "view:races.widget.fast",
      input: {},
      registrationId: first.registrationId,
    });
    expect(staleCall.status === "error" && staleCall.error.code).toBe("STALE_CAPABILITY");
    expect(staleCall.status === "error" && staleCall.error.details?.reason).toBe(
      "registration-replaced",
    );

    const liveCall = await registry.invoke({
      capabilityId: "view:races.widget.fast",
      input: {},
      registrationId: second.registrationId,
    });
    expect(liveCall.status).toBe("ok");
  });
});

describe("bounded collections under a fake clock (D24, §7.3)", () => {
  it("tombstones expire by TTL (COMPONENT_UNMOUNTED decays to CAPABILITY_NOT_FOUND)", async () => {
    let clock = 0;
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      now: () => clock,
      limits: { tombstoneTtlMs: 1_000 },
    });
    const handle = registry.register(deferredAction().definition);
    handle.unregister();
    const fresh = await registry.invoke({
      capabilityId: "view:races.widget.fast",
      input: {},
      registrationId: handle.registrationId,
    });
    expect(fresh.status === "error" && fresh.error.code).toBe("COMPONENT_UNMOUNTED");

    clock += 1_001; // the tombstone's recency claim expires
    const decayed = await registry.invoke({
      capabilityId: "view:races.widget.fast",
      input: {},
      registrationId: handle.registrationId,
    });
    expect(decayed.status === "error" && decayed.error.code).toBe("CAPABILITY_NOT_FOUND");
  });

  it("tombstones evict oldest-first at the size cap", async () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      limits: { tombstoneSize: 1 },
    });
    const a = registry.register({ ...deferredAction().definition, instanceId: "a" });
    const b = registry.register({ ...deferredAction().definition, instanceId: "b" });
    a.unregister();
    b.unregister(); // evicts a's tombstone (cap 1)
    const evicted = await registry.invoke({
      capabilityId: "view:races.widget.fast",
      input: {},
      instanceId: "a",
      registrationId: a.registrationId,
    });
    expect(evicted.status === "error" && evicted.error.code).toBe("CAPABILITY_NOT_FOUND");
    const kept = await registry.invoke({
      capabilityId: "view:races.widget.fast",
      input: {},
      instanceId: "b",
      registrationId: b.registrationId,
    });
    expect(kept.status === "error" && kept.error.code).toBe("COMPONENT_UNMOUNTED");
  });

  it("dedupe evicts deterministically at the size cap (oldest terminal first)", async () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      limits: { dedupeCacheSize: 2 },
    });
    let executions = 0;
    registry.register({
      type: "races.counter",
      description: "counts",
      actions: {
        bump: action({
          description: "bump",
          input: EmptyInput,
          effect: "local-state",
          execute: () => {
            executions += 1;
          },
        }),
      },
    });
    const invoke = (id: string) =>
      registry.invoke({ invocationId: id, capabilityId: "view:races.counter.bump", input: {} });
    await invoke("i1");
    await invoke("i2");
    await invoke("i3"); // evicts i1
    expect(executions).toBe(3);
    await invoke("i1"); // no longer deduped: a new attempt
    expect(executions).toBe(4);
    await invoke("i3"); // still cached
    expect(executions).toBe(4);
  });
});
