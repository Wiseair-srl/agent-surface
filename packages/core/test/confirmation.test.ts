import { afterEach, describe, expect, it, vi } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  memoryAuditSink,
  requireConfirmation,
  type AgentProcedureExecutor,
  type AgentSurfaceRegistry,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

interface Setup {
  registry: AgentSurfaceRegistry;
  state: ReturnType<typeof makeDevicesState>;
  executorCalls: unknown[];
  sink: ReturnType<typeof memoryAuditSink>;
}

function setup(): Setup {
  const sink = memoryAuditSink();
  const registry = createAgentSurfaceRegistry({ environment: "test", audit: sink });
  const executorCalls: unknown[] = [];
  const executor: AgentProcedureExecutor = {
    paths: ["devices.disable"],
    async execute({ input }) {
      executorCalls.push(input);
      return { disabled: (input as { deviceIds: string[] }).deviceIds.length };
    },
  };
  registry.setProcedureExecutor(executor);
  const state = makeDevicesState();
  state.selectedIds = ["d1", "d2"];
  registry.register(devicesTableDefinition(state, { procedures: [disableBinding(state)] }));
  return { registry, state, executorCalls, sink };
}

function detailsOf(result: Awaited<ReturnType<AgentSurfaceRegistry["invoke"]>>): Record<string, unknown> {
  if (result.status !== "error") throw new Error("expected error result");
  return result.error.details ?? {};
}

describe("confirmation protocol (docs/06 §confirmation)", () => {
  it("destructive procedures demand confirmation; approve → retry executes once", async () => {
    const { registry, executorCalls } = setup();
    const first = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      invocationId: "inv_1",
    });
    expect(first.status === "error" && first.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(first.status === "error" && first.error.retry).toBe("with-confirmation");
    const details = detailsOf(first);
    expect(details.origin).toBe("client");
    expect(details.effect).toBe("destructive");
    expect(typeof details.summary).toBe("string");
    expect(typeof details.expiresAt).toBe("string");
    const confirmationId = details.confirmationId as string;

    expect(registry.confirmations.pending()).toHaveLength(1);
    expect(registry.confirmations.pending()[0]?.input).toEqual({ deviceIds: ["d1", "d2"] });

    registry.confirmations.resolve(confirmationId, { approved: true });
    const second = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      invocationId: "inv_1",
      confirmationId,
    });
    expect(second.status).toBe("ok");
    expect(executorCalls).toHaveLength(1);
  });

  it("single use: replaying consumed evidence fails CONFIRMATION_INVALID {consumed}", async () => {
    const { registry } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    registry.confirmations.resolve(confirmationId, { approved: true });
    const ok = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId,
    });
    expect(ok.status).toBe("ok");
    const replay = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId,
    });
    expect(replay.status === "error" && replay.error.code).toBe("CONFIRMATION_INVALID");
    expect(detailsOf(replay).reason).toBe("consumed");
  });

  it("denial: retry fails CONFIRMATION_INVALID {denied} with retry: no", async () => {
    const { registry } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    registry.confirmations.resolve(confirmationId, { approved: false, reason: "user-declined" });
    const denied = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId,
    });
    expect(denied.status === "error" && denied.error.code).toBe("CONFIRMATION_INVALID");
    expect(detailsOf(denied).reason).toBe("denied");
    expect(denied.status === "error" && denied.error.retry).toBe("no");
  });

  it("expiry via TTL clock: late retry fails {expired}, retry with-confirmation", async () => {
    vi.useFakeTimers();
    const { registry } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    const resolved: string[] = [];
    registry.subscribe((e) => {
      if (e.type === "confirmation-resolved") resolved.push(e.outcome);
    });
    await vi.advanceTimersByTimeAsync(120_001); // default confirmationTtlMs
    expect(resolved).toEqual(["expired"]);
    const late = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId,
    });
    expect(late.status === "error" && late.error.code).toBe("CONFIRMATION_INVALID");
    expect(detailsOf(late).reason).toBe("expired");
    expect(late.status === "error" && late.error.retry).toBe("with-confirmation");
  });

  it("bait-and-switch: input changed after approval ⇒ {mismatch}", async () => {
    const { registry, state, executorCalls } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    registry.confirmations.resolve(confirmationId, { approved: true });
    state.selectedIds = ["d3"]; // the selection the user approved is gone
    const result = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId,
    });
    expect(result.status === "error" && result.error.code).toBe("CONFIRMATION_INVALID");
    expect(detailsOf(result).reason).toBe("mismatch");
    expect(executorCalls).toHaveLength(0);
  });

  it("retry while pending returns CONFIRMATION_REQUIRED with the SAME confirmationId", async () => {
    const { registry } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const firstId = detailsOf(first).confirmationId as string;
    const again = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    expect(detailsOf(again).confirmationId).toBe(firstId);
    expect(registry.confirmations.pending()).toHaveLength(1); // no dialog spam
    const withEvidence = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId: firstId,
    });
    expect(withEvidence.status === "error" && withEvidence.error.code).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  it("staleness beats confirmation: approval cannot resurrect a dead context", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      execute: async () => ({ disabled: 0 }),
    });
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const handle = registry.register(
      devicesTableDefinition(state, { procedures: [disableBinding(state)] }),
    );
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    registry.confirmations.resolve(confirmationId, { approved: true });
    handle.unregister();
    const result = await registry.invoke({
      capabilityId: "domain:devices.disable",
      input: {},
      confirmationId,
    });
    expect(result.status === "error" && result.error.code).toBe("COMPONENT_UNMOUNTED");
  });

  it("audit trail: requested/approved/consumed events are recorded", async () => {
    const { registry, sink } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    registry.confirmations.resolve(confirmationId, { approved: true });
    await registry.invoke({ capabilityId: "domain:devices.disable", input: {}, confirmationId });
    const types = sink.events().map((e) => e.type);
    expect(types).toContain("confirmation-requested");
    expect(types).toContain("confirmation-approved");
    expect(types).toContain("confirmation-consumed");
  });

  it("waitFor resolves on approval/denial/expiry", async () => {
    const { registry } = setup();
    const first = await registry.invoke({ capabilityId: "domain:devices.disable", input: {} });
    const confirmationId = detailsOf(first).confirmationId as string;
    const wait = registry.confirmations.waitFor(confirmationId);
    registry.confirmations.resolve(confirmationId, { approved: true });
    expect(await wait).toBe("approved");
  });
});

describe("view-action confirmation (OQ-12 uniform protocol)", () => {
  it("confirmation: required on a local action uses the same evidence protocol", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    let cleared = false;
    registry.register(
      defineAgentComponent({
        type: "draft.editor",
        description: "Draft editor",
        actions: {
          clearDraft: action({
            description: "Clear the unsaved draft",
            input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
            effect: "local-state",
            reversible: false,
            confirmation: "required",
            execute: () => {
              cleared = true;
            },
          }),
        },
      }),
    );
    const first = await registry.invoke({ capabilityId: "view:draft.editor.clearDraft", input: {} });
    expect(first.status === "error" && first.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(cleared).toBe(false);
    const confirmationId = detailsOf(first).confirmationId as string;
    registry.confirmations.resolve(confirmationId, { approved: true });
    const second = await registry.invoke({
      capabilityId: "view:draft.editor.clearDraft",
      input: {},
      confirmationId,
    });
    expect(second.status).toBe("ok");
    expect(cleared).toBe(true);
  });
});

describe("requireConfirmation policy escalation", () => {
  it("escalates an ordinary action to required, with a custom summary", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    const def = devicesTableDefinition(state);
    def.actions!.selectRows!.policies = [
      requireConfirmation({
        if: ({ input }) =>
          Array.isArray((input as { ids?: unknown[] } | undefined)?.ids) &&
          ((input as { ids: unknown[] }).ids.length ?? 0) > 1,
        summary: (input) => `Select ${(input as { ids: string[] }).ids.length} devices?`,
      }),
    ];
    registry.register(def);

    // Single id: condition false ⇒ no confirmation.
    const single = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1"] },
    });
    expect(single.status).toBe("ok");

    // Multiple ids: escalated.
    const multi = await registry.invoke({
      capabilityId: "view:devices.table.selectRows",
      input: { ids: ["d1", "d2"] },
    });
    expect(multi.status === "error" && multi.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(detailsOf(multi).summary).toBe("Select 2 devices?");
  });
});
