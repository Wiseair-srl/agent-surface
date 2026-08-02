// Conformance: AS-BIND-001 (schema surgery matrix D7), AS-BIND-002 (locking/override/full-schema revalidation D8), AS-BIND-003 (manifest exposure gating)
import { describe, expect, it } from "vitest";
import {
  createOrpcAgentBridge,
  isBridgeRef,
  type OrpcAgentManifest,
} from "@agent-surface/orpc";
import { bindAgentProcedure, reduceInputSchema } from "../src/binding.js";
import { createTestSurface } from "@agent-surface/testing";
import { matchers } from "@agent-surface/testing/matchers";
import type { JsonValue, ProcedureCallInfo } from "@agent-surface/core";

expect.extend(matchers);

interface DisableInput {
  deviceIds: string[];
  reason?: string;
}

const manifest: OrpcAgentManifest = {
  tools: {
    "devices.disable": {
      description: "Disable the given devices",
      inputSchema: {
        type: "object",
        properties: {
          deviceIds: { type: "array", items: { type: "string" }, minItems: 1 },
          reason: { type: "string" },
        },
        required: ["deviceIds"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { disabled: { type: "number" } },
        required: ["disabled"],
      },
      effect: "destructive",
    },
    "devices.list": {
      description: "List devices",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        additionalProperties: false,
      },
      effect: "server-query",
    },
  },
};

function makeClient(log: Array<{ path: string; input: unknown; options?: unknown }>) {
  return {
    devices: {
      disable: async (input: DisableInput, options?: unknown) => {
        log.push({ path: "devices.disable", input, options });
        return { disabled: input.deviceIds.length };
      },
      list: async (input: { city?: string }, options?: unknown) => {
        log.push({ path: "devices.list", input, options });
        return { items: [] };
      },
      hidden: async () => ({ secret: true }), // NOT in the manifest
    },
  };
}

describe("createOrpcAgentBridge (docs/05)", () => {
  it("builds typed refs ONLY for manifest paths — the manifest is the ceiling", () => {
    const bridge = createOrpcAgentBridge({ client: makeClient([]), manifest });
    expect(isBridgeRef(bridge.refs.devices.disable)).toBe(true);
    expect(bridge.refs.devices.disable.id).toBe("domain:devices.disable");
    expect(bridge.refs.devices.disable.effect).toBe("destructive");
    expect(bridge.hasPath("devices.disable")).toBe(true);
    expect(bridge.hasPath("devices.hidden")).toBe(false);
    expect((bridge.refs.devices as Record<string, unknown>).hidden).toBeUndefined();
  });

  it("executor exposes manifest paths for the suffix-collision lint", () => {
    const bridge = createOrpcAgentBridge({ client: makeClient([]), manifest });
    expect(bridge.executor.paths).toEqual(["devices.disable", "devices.list"]);
  });

  it("executor forwards calls through the client with signal + callContext", async () => {
    const log: Array<{ path: string; input: unknown; options?: unknown }> = [];
    const bridge = createOrpcAgentBridge({
      client: makeClient(log),
      manifest,
      callContext: (info) => ({ agentInvocationId: info.invocationId }),
    });
    const info: ProcedureCallInfo = {
      invocationId: "inv_42",
      consumer: { id: "test", kind: "test" },
      signal: new AbortController().signal,
    };
    const output = await bridge.executor.execute({
      path: "devices.disable",
      input: { deviceIds: ["d1"] },
      info,
    });
    expect(output).toEqual({ disabled: 1 });
    expect(log[0]?.options).toMatchObject({ context: { agentInvocationId: "inv_42" } });
  });

  it("maps UNAUTHORIZED server errors to NOT_AUTHORIZED {origin: server}", async () => {
    const bridge = createOrpcAgentBridge({
      client: {
        devices: {
          disable: async () => {
            const err = new Error("Unauthorized") as Error & { code: string };
            err.code = "UNAUTHORIZED";
            throw err;
          },
          list: async () => ({ items: [] }),
        },
      },
      manifest,
    });
    await expect(
      bridge.executor.execute({
        path: "devices.disable",
        input: { deviceIds: ["d1"] },
        info: {
          invocationId: "inv",
          consumer: { id: "t", kind: "test" },
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toMatchObject({ payload: { code: "NOT_AUTHORIZED", details: { origin: "server" } } });
  });

  it("maps server approval demands to CONFIRMATION_REQUIRED {origin: server}", async () => {
    const bridge = createOrpcAgentBridge({
      client: {
        devices: {
          disable: async () => {
            const err = new Error("approval required") as Error & { data: unknown };
            err.data = { approvalRequired: true, approvalId: "apr_1" };
            throw err;
          },
          list: async () => ({ items: [] }),
        },
      },
      manifest,
    });
    await expect(
      bridge.executor.execute({
        path: "devices.disable",
        input: { deviceIds: ["d1"] },
        info: {
          invocationId: "inv",
          consumer: { id: "t", kind: "test" },
          signal: new AbortController().signal,
        },
      }),
    ).rejects.toMatchObject({
      payload: {
        code: "CONFIRMATION_REQUIRED",
        details: { origin: "server", confirmationId: "apr_1" },
      },
    });
  });

  it("sanitizes unknown transport errors: no error.message pass-through", async () => {
    const bridge = createOrpcAgentBridge({
      client: {
        devices: {
          disable: async () => {
            throw new Error("connect ECONNREFUSED 10.0.0.3:5432 (postgres://internal)");
          },
          list: async () => ({ items: [] }),
        },
      },
      manifest,
    });
    try {
      await bridge.executor.execute({
        path: "devices.disable",
        input: { deviceIds: ["d1"] },
        info: {
          invocationId: "inv",
          consumer: { id: "t", kind: "test" },
          signal: new AbortController().signal,
        },
      });
      expect.unreachable();
    } catch (err) {
      const payload = (err as { payload: { code: string; message: string } }).payload;
      expect(payload.code).toBe("EXECUTION_FAILED");
      expect(payload.message).not.toContain("ECONNREFUSED");
      expect(payload.message).not.toContain("postgres");
    }
  });
});

describe("schema surgery (D7)", () => {
  const full = manifest.tools["devices.disable"]!.inputSchema;

  it("locked bound fields are removed from properties AND required", () => {
    const reduced = reduceInputSchema(full, ["deviceIds"], new Set());
    expect(Object.keys(reduced.properties as object)).toEqual(["reason"]);
    expect(reduced.required).toBeUndefined();
  });

  it("all-bound ⇒ empty closed object schema", () => {
    const reduced = reduceInputSchema(full, ["deviceIds", "reason"], new Set());
    expect(reduced).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("none bound ⇒ schema unchanged", () => {
    const reduced = reduceInputSchema(full, [], new Set());
    expect(reduced).toEqual(full);
  });

  it("overridable bound fields stay in the schema, annotated, no longer required", () => {
    const reduced = reduceInputSchema(full, ["deviceIds"], new Set(["deviceIds"]));
    expect(Object.keys(reduced.properties as object)).toEqual(["deviceIds", "reason"]);
    const prop = (reduced.properties as Record<string, { description?: string }>).deviceIds;
    expect(prop?.description).toContain("current UI value");
    expect(reduced.required).toBeUndefined();
  });
});

describe("bindAgentProcedure + registry integration (docs/05 binding semantics)", () => {
  function integration(opts?: {
    overridableFields?: Array<"reason">;
    selection?: string[];
  }) {
    const surface = createTestSurface();
    const log: Array<{ path: string; input: unknown }> = [];
    const bridge = createOrpcAgentBridge({ client: makeClient(log), manifest });
    surface.registry.setProcedureExecutor(bridge.executor);
    const state = { selectedIds: opts?.selection ?? ["d1", "d2"] };
    const binding = bindAgentProcedure<DisableInput, { disabled: number }, Partial<DisableInput>>(
      bridge.refs.devices.disable,
      {
        when: () => state.selectedIds.length > 0,
        unavailableReason: "Select at least one device first",
        bind: () => ({ deviceIds: state.selectedIds }),
        ...(opts?.overridableFields ? { overridableFields: opts.overridableFields } : {}),
        confirmation: "required",
        describe: () => `Currently bound to the ${state.selectedIds.length} selected device(s)`,
      },
    );
    surface.registry.register({
      type: "devices.table",
      description: "Devices table",
      procedures: [binding],
    });
    return { surface, state, log };
  }

  it("descriptor: reduced schema, boundFields metadata, contextual description", () => {
    const { surface } = integration();
    const descriptor = surface.snapshot().procedures[0]!;
    expect(descriptor.procedureId).toBe("domain:devices.disable");
    expect(descriptor.effect).toBe("destructive");
    expect(descriptor.confirmation).toBe("required");
    expect(descriptor.available).toBe(true);
    expect(descriptor.boundFields).toEqual([
      { path: "deviceIds", locked: true, source: "ui-state" },
    ]);
    expect(Object.keys(descriptor.inputSchema.properties as object)).toEqual(["reason"]);
    expect(descriptor.description).toBe("Disable the given devices");
    // The contextual half is data, never folded into the manifest text (D28).
    expect(descriptor.contextualNote).toContain("Currently bound to the 2 selected device(s)");
    // A procedures-only definition has no owning VIEW component, so the
    // context link is absent (page-level reference, docs/05). The linked case
    // is covered by the React useAgentComponent + useAgentProcedure tests.
    expect(descriptor.context).toBeUndefined();
  });

  it("locked override ⇒ INVALID_INPUT {lockedFields} (docs/08 recipe)", async () => {
    const { surface } = integration();
    const result = await surface.invoke("domain:devices.disable", { deviceIds: ["victim"] });
    expect(result).toFailWith("INVALID_INPUT", { lockedFields: ["deviceIds"] });
  });

  it("full disable flow: confirm → approve → executor receives merged input", async () => {
    const { surface, log } = integration();
    let result = await surface.invoke("domain:devices.disable", {});
    expect(result).toFailWith("CONFIRMATION_REQUIRED");
    surface.confirmations.approve();
    const confirmationId =
      result.status === "error" ? (result.error.details?.confirmationId as string) : "";
    result = await surface.invoke("domain:devices.disable", {}, { confirmationId });
    expect(result).toBeOk();
    expect(log).toHaveLength(1);
    expect(log[0]?.input).toEqual({ deviceIds: ["d1", "d2"] });
  });

  it("overridable fields: agent value wins; omitted ⇒ bound value applies", async () => {
    const surface = createTestSurface();
    const log: Array<{ path: string; input: unknown }> = [];
    const bridge = createOrpcAgentBridge({ client: makeClient(log), manifest });
    surface.registry.setProcedureExecutor(bridge.executor);
    const binding = bindAgentProcedure<DisableInput, { disabled: number }, Partial<DisableInput>>(
      bridge.refs.devices.disable,
      {
        bind: () => ({ deviceIds: ["d1"], reason: "from-ui" }),
        overridableFields: ["reason"],
      },
    );
    surface.registry.register({
      type: "devices.table",
      description: "Devices table",
      procedures: [binding],
    });
    // destructive ⇒ confirmation; approve then execute, agent overrides reason.
    let result = await surface.invoke("domain:devices.disable", { reason: "agent-reason" });
    surface.confirmations.approve();
    const confirmationId =
      result.status === "error" ? (result.error.details?.confirmationId as string) : "";
    result = await surface.invoke(
      "domain:devices.disable",
      { reason: "agent-reason" },
      { confirmationId },
    );
    expect(result).toBeOk();
    expect(log[0]?.input).toEqual({ deviceIds: ["d1"], reason: "agent-reason" });

    // Omitted ⇒ bound value applies.
    let second = await surface.invoke("domain:devices.disable", {});
    surface.confirmations.approve();
    const secondId =
      second.status === "error" ? (second.error.details?.confirmationId as string) : "";
    second = await surface.invoke("domain:devices.disable", {}, { confirmationId: secondId });
    expect(second).toBeOk();
    expect(log[1]?.input).toEqual({ deviceIds: ["d1"], reason: "from-ui" });
  });

  it("contextual availability: empty selection ⇒ visible-disabled with the binding's reason", async () => {
    const { surface } = integration({ selection: [] });
    expect(surface).toExposeUnavailable("domain:devices.disable", {
      reason: "Select at least one device first",
    });
    const result = await surface.invoke("domain:devices.disable", {});
    expect(result).toFailWith("CAPABILITY_NOT_AVAILABLE");
  });

  it("multiple simultaneous references ⇒ AMBIGUOUS_INSTANCE without a registrationId", async () => {
    const surface = createTestSurface();
    const bridge = createOrpcAgentBridge({ client: makeClient([]), manifest });
    surface.registry.setProcedureExecutor(bridge.executor);
    const mk = (ids: string[]) =>
      bindAgentProcedure<DisableInput, { disabled: number }, Partial<DisableInput>>(
        bridge.refs.devices.disable,
        { bind: () => ({ deviceIds: ids }) },
      );
    surface.registry.register({
      type: "devices.table",
      instanceId: "main",
      description: "Main table",
      procedures: [mk(["d1"])],
    });
    surface.registry.register({
      type: "devices.table",
      instanceId: "comparison",
      description: "Comparison table",
      procedures: [mk(["d2"])],
    });
    const result = await surface.invoke("domain:devices.disable", {});
    expect(result).toFailWith("AMBIGUOUS_INSTANCE");
    const instances =
      result.status === "error"
        ? (result.error.details?.instances as Array<{ context?: { instanceId: string } }>)
        : [];
    expect(instances).toHaveLength(2);
  });

  it("registering a view capability shadowing a manifest path triggers the suffix lint", () => {
    const surface = createTestSurface();
    const bridge = createOrpcAgentBridge({ client: makeClient([]), manifest });
    surface.registry.setProcedureExecutor(bridge.executor);
    surface.registry.register({
      type: "devices",
      description: "Devices page",
      actions: {
        disable: {
          description: "Shadowing view action (a smell)",
          input: { jsonSchema: { type: "object" }, parse: (v: unknown) => v as JsonValue },
          effect: "local-state",
          execute: () => {},
        },
      },
    });
    expect(
      surface
        .events()
        .some(
          (e) =>
            e.type === "collision-suspected" &&
            e.viewCapabilityId === "view:devices.disable" &&
            e.domainProcedureId === "domain:devices.disable",
        ),
    ).toBe(true);
  });
});
