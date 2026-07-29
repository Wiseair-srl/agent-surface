/**
 * Conformance: confirmation binds the validated effective input via the
 * canonical request digest (D21/D24; race names:
 * confirmation-approved-input-changed, binding-throws-before-confirmation).
 * Requirements: AS-INVOKE-005, AS-CONFIRM-001, AS-CONFIRM-002,
 * AS-CONFIRM-004, AS-CONFIRM-005.
 */
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  requireConfirmation,
  type AgentConsumer,
} from "@agent-surface/core";
import { disableBinding, makeDevicesState } from "../helpers.js";

const A: AgentConsumer = { id: "adapter-a", kind: "embedded" };
const B: AgentConsumer = { id: "adapter-b", kind: "embedded" };

function destructiveRegistry(state = makeDevicesState()) {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  let executions = 0;
  registry.setProcedureExecutor({
    paths: ["devices.disable"],
    execute: async () => {
      executions += 1;
      return { disabled: state.selectedIds.length };
    },
  });
  registry.register({
    type: "devices.toolbar",
    description: "toolbar",
    procedures: [disableBinding(state)],
  });
  return { registry, state, executions: () => executions };
}

describe("AS-INVOKE-005 — the confirmation shows bound (effective) values", () => {
  it("pending record input contains the live binding, not the agent's raw call", async () => {
    const { registry, state } = destructiveRegistry();
    state.selectedIds = ["d1"]; // discovery-time UI state
    state.selectedIds = ["d1", "d3"]; // changed again before invocation

    const result = await registry.invoke(
      { capabilityId: "domain:devices.disable", input: {} },
      { consumer: A },
    );
    expect(result.status === "error" && result.error.code).toBe("CONFIRMATION_REQUIRED");
    const pending = registry.confirmations.pending();
    expect(pending).toHaveLength(1);
    // The user approves the CURRENT bound ids — the agent sent {}.
    expect(pending[0]?.input).toEqual({ deviceIds: ["d1", "d3"] });
    expect(pending[0]?.effect).toBe("destructive");
    expect(pending[0]?.consumerKey).toBe("embedded:adapter-a");
  });
});

describe("AS-CONFIRM-001 — confirmation-approved-input-changed", () => {
  it("a binding change after approval fails CONFIRMATION_INVALID(mismatch), never executes", async () => {
    const { registry, state, executions } = destructiveRegistry();
    state.selectedIds = ["d1"];

    const first = await registry.invoke(
      { invocationId: "inv_1", capabilityId: "domain:devices.disable", input: {} },
      { consumer: A },
    );
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    registry.confirmations.resolve(confirmationId, { approved: true });

    state.selectedIds = ["d2"]; // the UI moved after the user approved ["d1"]

    const retry = await registry.invoke(
      { invocationId: "inv_1", capabilityId: "domain:devices.disable", input: {}, confirmationId },
      { consumer: A },
    );
    expect(retry.status === "error" && retry.error.code).toBe("CONFIRMATION_INVALID");
    expect(retry.status === "error" && retry.error.details?.reason).toBe("mismatch");
    expect(executions()).toBe(0);
  });
});

describe("AS-CONFIRM-002 — canonical digest: key order is irrelevant, values are exact", () => {
  it("an approval validates for the same input in a different key insertion order", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register({
      type: "conf.form",
      description: "form",
      actions: {
        submitDraft: action({
          description: "submit the draft",
          input: fromJsonSchema<{ title: string; body: string }>({
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
            required: ["title", "body"],
            additionalProperties: false,
          }),
          effect: "local-state",
          policies: [requireConfirmation()],
          execute: () => {},
        }),
      },
    });

    const first = await registry.invoke(
      {
        invocationId: "inv_a",
        capabilityId: "view:conf.form.submitDraft",
        input: { title: "t", body: "b" },
      },
      { consumer: A },
    );
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    registry.confirmations.resolve(confirmationId, { approved: true });

    // Same values, opposite key order: canonically identical (D21).
    const retry = await registry.invoke(
      {
        invocationId: "inv_a",
        capabilityId: "view:conf.form.submitDraft",
        input: { body: "b", title: "t" },
        confirmationId,
      },
      { consumer: A },
    );
    expect(retry.status).toBe("ok");
  });

  it("a value change of equal shape/length still mismatches (exact-value matching)", async () => {
    const { registry, state } = destructiveRegistry();
    state.selectedIds = ["d1"];
    const first = await registry.invoke(
      { invocationId: "inv_b", capabilityId: "domain:devices.disable", input: {} },
      { consumer: A },
    );
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    registry.confirmations.resolve(confirmationId, { approved: true });
    state.selectedIds = ["d2"]; // same length, same shape, different value
    const retry = await registry.invoke(
      { invocationId: "inv_b", capabilityId: "domain:devices.disable", input: {}, confirmationId },
      { consumer: A },
    );
    expect(retry.status === "error" && retry.error.details?.reason).toBe("mismatch");
  });
});

describe("AS-CONFIRM-004 — approval is bound to consumer, registration, and capability", () => {
  it("another consumer cannot spend the approval", async () => {
    const { registry, state, executions } = destructiveRegistry();
    state.selectedIds = ["d1"];
    const first = await registry.invoke(
      { invocationId: "inv_c", capabilityId: "domain:devices.disable", input: {} },
      { consumer: A },
    );
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    registry.confirmations.resolve(confirmationId, { approved: true });

    const stolen = await registry.invoke(
      { invocationId: "inv_c", capabilityId: "domain:devices.disable", input: {}, confirmationId },
      { consumer: B }, // digest includes consumerKey ⇒ mismatch
    );
    expect(stolen.status === "error" && stolen.error.code).toBe("CONFIRMATION_INVALID");
    expect(stolen.status === "error" && stolen.error.details?.reason).toBe("mismatch");
    expect(executions()).toBe(0);
  });

  it("a replaced registration invalidates the approval", async () => {
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      onDuplicateInstance: "replace",
    });
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
      procedures: [disableBinding(state)],
    });
    const first = await registry.invoke(
      { invocationId: "inv_d", capabilityId: "domain:devices.disable", input: {} },
      { consumer: A },
    );
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    registry.confirmations.resolve(confirmationId, { approved: true });

    // Remount: a new registrationId now owns the reference (digest mismatch).
    registry.register({
      type: "devices.toolbar",
      description: "toolbar",
      procedures: [disableBinding(state)],
    });
    const retry = await registry.invoke(
      { invocationId: "inv_d", capabilityId: "domain:devices.disable", input: {}, confirmationId },
      { consumer: A },
    );
    expect(retry.status === "error" && retry.error.code).toBe("CONFIRMATION_INVALID");
    expect(retry.status === "error" && retry.error.details?.reason).toBe("mismatch");
    expect(executions).toBe(0);
  });
});

describe("AS-CONFIRM-005 — the pending store is bounded and fails closed", () => {
  it("overflow yields RATE_LIMITED(queue-full) with no record created", async () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      limits: { maxPendingConfirmations: 2 },
    });
    registry.register({
      type: "conf.form",
      description: "form",
      actions: {
        submitDraft: action({
          description: "submit",
          input: fromJsonSchema<{ n: number }>({
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
            additionalProperties: false,
          }),
          effect: "local-state",
          policies: [requireConfirmation()],
          execute: () => {},
        }),
      },
    });

    const invokeN = (n: number) =>
      registry.invoke(
        { capabilityId: "view:conf.form.submitDraft", input: { n } },
        { consumer: A },
      );
    expect((await invokeN(1)).status === "error").toBe(true);
    expect((await invokeN(2)).status === "error").toBe(true);
    expect(registry.confirmations.pending()).toHaveLength(2);

    const third = await invokeN(3);
    expect(third.status === "error" && third.error.code).toBe("RATE_LIMITED");
    expect(third.status === "error" && third.error.details?.reason).toBe("queue-full");
    expect(registry.confirmations.pending()).toHaveLength(2); // no record created

    // Re-requesting an EXISTING pending is not an overflow (same digest reuses it).
    const repeat = await invokeN(1);
    expect(repeat.status === "error" && repeat.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(registry.confirmations.pending()).toHaveLength(2);
  });
});
