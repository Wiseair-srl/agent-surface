/**
 * Conformance: two-stage policy pipeline (D21, docs/18 §correction 1).
 * Requirements: AS-INVOKE-001, AS-INVOKE-002, AS-INVOKE-003, AS-INVOKE-004,
 * AS-POLICY-001.
 */
import { describe, expect, it } from "vitest";
import {
  createAgentSurfaceRegistry,
  rateLimit,
  type AgentPolicy,
  type JsonValue,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "../helpers.js";

const CONSUMER = { id: "conformance", kind: "test" as const };

describe("AS-INVOKE-001 — onAuthorize cannot observe agent input", () => {
  it("runs before bind()/parse and its context carries no input field", async () => {
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const order: string[] = [];
    let authorizeCtxKeys: string[] = [];
    const probe: AgentPolicy = {
      name: "probe",
      async onAuthorize(ctx, next) {
        order.push("authorize");
        authorizeCtxKeys = Object.keys(ctx);
        return next();
      },
      async onInvoke(ctx, next) {
        order.push("invoke-policy");
        return next();
      },
    };
    const registry = createAgentSurfaceRegistry({ environment: "test", policies: [probe] });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      execute: async () => {
        order.push("execute");
        return { disabled: 1 };
      },
    });
    const binding = disableBinding(state, {
      effect: "server-mutation",
      bind: () => {
        order.push("bind");
        return { deviceIds: state.selectedIds };
      },
    });
    registry.register({ type: "devices.toolbar", description: "toolbar", procedures: [binding] });

    const result = await registry.invoke(
      { capabilityId: "domain:devices.disable", input: {} },
      { consumer: CONSUMER },
    );
    expect(result.status).toBe("ok");
    expect(order).toEqual(["authorize", "bind", "invoke-policy", "execute"]);
    expect(authorizeCtxKeys).not.toContain("input");
    expect(authorizeCtxKeys).not.toContain("effectiveInput");
  });
});

describe("AS-INVOKE-002 — onInvoke receives only the validated effective input", () => {
  it("procedure policies see merged bound values, never the raw agent input", async () => {
    const state = makeDevicesState();
    state.selectedIds = ["d1", "d3"];
    let seen: JsonValue | undefined;
    const probe: AgentPolicy = {
      name: "probe",
      async onInvoke(ctx, next) {
        seen = ctx.effectiveInput;
        return next();
      },
    };
    const registry = createAgentSurfaceRegistry({ environment: "test", policies: [probe] });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      execute: async () => ({ disabled: 2 }),
    });
    registry.register({
      type: "devices.toolbar",
      description: "toolbar",
      procedures: [disableBinding(state, { effect: "server-mutation" })],
    });

    // The agent supplies only `reason`; deviceIds is a locked binding.
    const result = await registry.invoke(
      { capabilityId: "domain:devices.disable", input: { reason: "maintenance" } },
      { consumer: CONSUMER },
    );
    expect(result.status).toBe("ok");
    expect(seen).toEqual({ reason: "maintenance", deviceIds: ["d1", "d3"] });
  });

  it("action policies see the parsed (defaulted) input after schema validation", async () => {
    const state = makeDevicesState();
    let seen: JsonValue | undefined;
    const probe: AgentPolicy = {
      name: "probe",
      async onInvoke(ctx, next) {
        seen = ctx.effectiveInput;
        return next();
      },
    };
    const registry = createAgentSurfaceRegistry({ environment: "test", policies: [probe] });
    registry.register(devicesTableDefinition(state));
    const invalid = await registry.invoke(
      { capabilityId: "view:devices.table.selectRows", input: { ids: [] } },
      { consumer: CONSUMER },
    );
    // Schema-invalid input never reaches phase 6.
    expect(invalid.status === "error" && invalid.error.code).toBe("INVALID_INPUT");
    expect(seen).toBeUndefined();

    const ok = await registry.invoke(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { consumer: CONSUMER },
    );
    expect(ok.status).toBe("ok");
    expect(seen).toEqual({ ids: ["d1"] });
  });
});

describe("AS-INVOKE-003 — a malformed binding fails before any confirmation record", () => {
  it("bind() throwing yields PRECONDITION_FAILED(binding-failed) and zero pendings", async () => {
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      execute: async () => ({ disabled: 1 }),
    });
    registry.register({
      type: "devices.toolbar",
      description: "toolbar",
      // destructive ⇒ confirmation would be required if we ever got that far
      procedures: [
        disableBinding(state, {
          bind: () => {
            throw new Error("ui state exploded");
          },
        }),
      ],
    });

    const result = await registry.invoke(
      { capabilityId: "domain:devices.disable", input: {} },
      { consumer: CONSUMER },
    );
    expect(result.status === "error" && result.error.code).toBe("PRECONDITION_FAILED");
    expect(result.status === "error" && result.error.details?.reason).toBe("binding-failed");
    expect(registry.confirmations.pending()).toHaveLength(0);
  });
});

describe("AS-INVOKE-004 — a supplied locked field fails before any confirmation record", () => {
  it("locked-field injection yields INVALID_INPUT and zero pendings", async () => {
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      execute: async () => ({ disabled: 1 }),
    });
    registry.register({
      type: "devices.toolbar",
      description: "toolbar",
      procedures: [disableBinding(state)],
    });

    const result = await registry.invoke(
      { capabilityId: "domain:devices.disable", input: { deviceIds: ["victim"] } },
      { consumer: CONSUMER },
    );
    expect(result.status === "error" && result.error.code).toBe("INVALID_INPUT");
    expect(result.status === "error" && result.error.details?.lockedFields).toEqual(["deviceIds"]);
    expect(registry.confirmations.pending()).toHaveLength(0);
  });
});

describe("AS-POLICY-001 — built-in policies run on the injectable clock", () => {
  it("rateLimit windows advance with the injected clock, not Date.now()", async () => {
    let clock = 1_000_000;
    const state = makeDevicesState();
    const def = devicesTableDefinition(state);
    def.actions!.selectRows!.policies = [rateLimit({ limit: 1, windowMs: 10_000 })];
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      now: () => clock,
    });
    registry.register(def);

    const first = await registry.invoke(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { consumer: CONSUMER },
    );
    expect(first.status).toBe("ok");

    const second = await registry.invoke(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d2"] } },
      { consumer: CONSUMER },
    );
    expect(second.status === "error" && second.error.code).toBe("RATE_LIMITED");
    expect(second.status === "error" && second.error.details?.retryAfterMs).toBe(10_000);

    clock += 10_001; // window elapses purely via the injected clock
    const third = await registry.invoke(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d3"] } },
      { consumer: CONSUMER },
    );
    expect(third.status).toBe("ok");
  });
});
