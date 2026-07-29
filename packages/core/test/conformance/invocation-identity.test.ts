/**
 * Conformance: consumer-scoped, conflict-safe invocation identity
 * (D22, docs/18 §correction 2; race names: duplicate-call-joins-inflight,
 * invocation-id-conflict-fails-closed).
 * Requirements: AS-IDENT-001, AS-IDENT-002, AS-IDENT-003, AS-IDENT-004,
 * AS-IDENT-005, AS-IDENT-006.
 */
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  type AgentConsumer,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "../helpers.js";

const A: AgentConsumer = { id: "adapter-a", kind: "embedded" };
const B: AgentConsumer = { id: "adapter-b", kind: "embedded" };

function slowCounterDefinition() {
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const definition = {
    type: "conf.counter",
    description: "counts executions",
    actions: {
      bump: action({
        description: "bump the counter",
        input: fromJsonSchema<{ by: number }>({
          type: "object",
          properties: { by: { type: "number" } },
          required: ["by"],
          additionalProperties: false,
        }),
        output: fromJsonSchema<{ count: number }>({
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        }),
        effect: "local-state" as const,
        execute: async ({ by }) => {
          executions += 1;
          await gate;
          return { count: executions * by };
        },
      }),
    },
  };
  return { definition, executions: () => executions, release: () => release?.() };
}

describe("AS-IDENT-001 — duplicate-call-joins-inflight (same consumer, same request)", () => {
  it("joins in-flight exactly once and returns the cached terminal afterwards", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const counter = slowCounterDefinition();
    registry.register(counter.definition);

    const request = {
      invocationId: "call_1",
      capabilityId: "view:conf.counter.bump",
      input: { by: 10 },
    };
    const p1 = registry.invoke(request, { consumer: A });
    const p2 = registry.invoke(request, { consumer: A }); // joins, never re-executes
    counter.release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(counter.executions()).toBe(1);
    expect(r1).toEqual(r2);
    expect(r1.status).toBe("ok");

    const replay = await registry.invoke(request, { consumer: A }); // cached terminal
    expect(counter.executions()).toBe(1);
    expect(replay.status === "ok" && replay.output).toEqual({ count: 10 });
  });
});

describe("AS-IDENT-002 — invocation-id-conflict-fails-closed (different input)", () => {
  it("same consumer + id + different input fails INVOCATION_CONFLICT, record untouched", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));

    const original = await registry.invoke(
      { invocationId: "call_x", capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { consumer: A },
    );
    expect(original.status).toBe("ok");

    const conflict = await registry.invoke(
      { invocationId: "call_x", capabilityId: "view:devices.table.selectRows", input: { ids: ["d2"] } },
      { consumer: A },
    );
    expect(conflict.status === "error" && conflict.error.code).toBe("INVOCATION_CONFLICT");
    expect(conflict.status === "error" && conflict.error.retry).toBe("with-changes");
    expect(conflict.status === "error" && conflict.error.details).toEqual({
      reason: "id-reused-with-different-request",
    });
    // No prior-request material leaks into agent-visible details.
    const detailKeys = conflict.status === "error" ? Object.keys(conflict.error.details ?? {}) : [];
    expect(detailKeys).toEqual(["reason"]);
    expect(state.selectedIds).toEqual(["d1"]); // second request never executed

    // The original record is untouched: the original request still replays.
    const replay = await registry.invoke(
      { invocationId: "call_x", capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { consumer: A },
    );
    expect(replay.status).toBe("ok");
  });

  it("conflicts fail closed against in-flight records too", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const counter = slowCounterDefinition();
    registry.register(counter.definition);

    const pending = registry.invoke(
      { invocationId: "call_y", capabilityId: "view:conf.counter.bump", input: { by: 1 } },
      { consumer: A },
    );
    const conflict = await registry.invoke(
      { invocationId: "call_y", capabilityId: "view:conf.counter.bump", input: { by: 2 } },
      { consumer: A },
    );
    expect(conflict.status === "error" && conflict.error.code).toBe("INVOCATION_CONFLICT");
    counter.release();
    expect((await pending).status).toBe("ok");
    expect(counter.executions()).toBe(1);
  });
});

describe("AS-IDENT-003 — invocation-id conflict on a different capability", () => {
  it("same consumer + id + different capability fails INVOCATION_CONFLICT", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));

    const first = await registry.invoke(
      { invocationId: "call_z", capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { consumer: A },
    );
    expect(first.status).toBe("ok");

    const conflict = await registry.invoke(
      { invocationId: "call_z", capabilityId: "view:devices.table.readState" },
      { consumer: A },
    );
    expect(conflict.status === "error" && conflict.error.code).toBe("INVOCATION_CONFLICT");
  });
});

describe("AS-IDENT-004 — consumers are independent id namespaces", () => {
  it("two consumers reuse the same provider tool-call id safely", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));

    const first = await registry.invoke(
      { invocationId: "toolcall_1", capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { consumer: A },
    );
    // Different consumer, same provider id, DIFFERENT request: no conflict,
    // executes independently.
    const second = await registry.invoke(
      { invocationId: "toolcall_1", capabilityId: "view:devices.table.selectRows", input: { ids: ["d2"], mode: "add" } },
      { consumer: B },
    );
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(state.selectedIds).toEqual(["d1", "d2"]);
  });
});

describe("AS-IDENT-005 — bounded idempotency window (fake clock)", () => {
  it("an expired key is a new attempt; eviction is deterministic", async () => {
    let clock = 0;
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      now: () => clock,
      limits: { dedupeCacheTtlMs: 1_000 },
    });
    const counter = slowCounterDefinition();
    counter.release(); // no gating needed here
    registry.register(counter.definition);

    const request = {
      invocationId: "call_ttl",
      capabilityId: "view:conf.counter.bump",
      input: { by: 1 },
    };
    expect((await registry.invoke(request, { consumer: A })).status).toBe("ok");
    expect(counter.executions()).toBe(1);

    clock += 500; // inside the window: cached, no re-execution
    await registry.invoke(request, { consumer: A });
    expect(counter.executions()).toBe(1);

    clock += 501; // window elapsed: a new attempt executes again
    const fresh = await registry.invoke(request, { consumer: A });
    expect(fresh.status).toBe("ok");
    expect(counter.executions()).toBe(2);
  });
});

describe("AS-IDENT-006 — confirmation retry semantics across the dedupe store", () => {
  it("CONFIRMATION_REQUIRED is not cached; the evidence retry executes once; a NEW id with consumed evidence fails", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    let executions = 0;
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      execute: async () => {
        executions += 1;
        return { disabled: 1 };
      },
    });
    registry.register({
      type: "devices.toolbar",
      description: "toolbar",
      procedures: [disableBinding(state)], // destructive ⇒ confirmation required
    });

    const request = { invocationId: "call_c", capabilityId: "domain:devices.disable", input: {} };
    const first = await registry.invoke(request, { consumer: A });
    expect(first.status === "error" && first.error.code).toBe("CONFIRMATION_REQUIRED");
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";

    registry.confirmations.resolve(confirmationId, { approved: true });

    // Same invocationId + confirmationId: executes exactly once (D14 rule).
    const approved = await registry.invoke({ ...request, confirmationId }, { consumer: A });
    expect(approved.status).toBe("ok");
    expect(executions).toBe(1);

    // Exact same request again: cached terminal, still one execution.
    const replaySame = await registry.invoke({ ...request, confirmationId }, { consumer: A });
    expect(replaySame.status).toBe("ok");
    expect(executions).toBe(1);

    // A NEW invocationId replaying the consumed evidence is refused.
    const replayNew = await registry.invoke(
      { ...request, invocationId: "call_c2", confirmationId },
      { consumer: A },
    );
    expect(replayNew.status === "error" && replayNew.error.code).toBe("CONFIRMATION_INVALID");
    expect(replayNew.status === "error" && replayNew.error.details?.reason).toBe("consumed");
    expect(executions).toBe(1);
  });
});
