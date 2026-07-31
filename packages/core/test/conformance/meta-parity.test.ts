/**
 * Conformance: meta-tools mode preserves the direct-mode contract (docs/09
 * §meta-tools-mode). Requirements: AS-ADAPTER-004 (resolution parity),
 * AS-ADAPTER-005 (configured scope is a floor, D27).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSurfaceRegistry,
  createAgentToolset,
  type AgentInvocationResult,
  type AgentProcedureExecutor,
  type AgentSurfaceRegistry,
  type AgentTool,
  type AgentToolset,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "../helpers.js";

function tool(toolset: AgentToolset, name: string): AgentTool {
  const found = toolset.tools().find((t) => t.name === name);
  if (!found) throw new Error(`missing ${name}: ${toolset.tools().map((t) => t.name).join(", ")}`);
  return found;
}

function errorCode(result: AgentInvocationResult): string {
  return result.status === "error" ? result.error.code : `ok(${result.status})`;
}

function metaToolset(
  registry: AgentSurfaceRegistry,
  options: { scope?: string[]; confirmations?: "wait" | "two-phase" } = {},
): AgentToolset {
  return createAgentToolset(registry, {
    consumer: { id: "copilot", kind: "embedded" },
    topology: "embedded",
    mode: "meta",
    ...options,
  });
}

describe("meta mode ↔ direct mode parity (AS-ADAPTER-004)", () => {
  it("ambiguous target yields AMBIGUOUS_INSTANCE, not a STALE_CAPABILITY refresh loop", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "a" });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "b" });
    const meta = metaToolset(registry);

    // Reads and acts must agree: both are ambiguous, both say so with a retry
    // the agent can act on. `after-refresh` here would be a lie — refreshing
    // returns the same two instances forever.
    const read = await tool(meta, "surface_read").execute(
      { capabilityId: "view:devices.table.readState" },
      {},
    );
    expect(errorCode(read)).toBe("AMBIGUOUS_INSTANCE");
    expect(read.status === "error" && read.error.retry).toBe("with-changes");
    expect(read.status === "error" && read.error.details?.instances).toHaveLength(2);

    const act = await tool(meta, "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      {},
    );
    expect(errorCode(act)).toBe("AMBIGUOUS_INSTANCE");
  });

  it("an explicit instanceId disambiguates both meta verbs", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const a = makeDevicesState();
    const b = makeDevicesState();
    registry.register({ ...devicesTableDefinition(a), instanceId: "a" });
    registry.register({ ...devicesTableDefinition(b), instanceId: "b" });
    const meta = metaToolset(registry);

    const read = await tool(meta, "surface_read").execute(
      { capabilityId: "view:devices.table.readState", instanceId: "b" },
      {},
    );
    expect(read.status).toBe("ok");

    const act = await tool(meta, "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", instanceId: "b", input: { ids: ["d1"] } },
      {},
    );
    expect(act.status).toBe("ok");
    expect(b.selectedIds).toEqual(["d1"]);
    expect(a.selectedIds).toEqual([]); // the other instance is untouched
  });

  it("unknown and unmounted targets keep their direct-mode error codes", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry);

    const unknown = await tool(meta, "surface_read").execute(
      { capabilityId: "view:devices.table.doesNotExist" },
      {},
    );
    expect(errorCode(unknown)).toBe("CAPABILITY_NOT_FOUND");

    handle.unregister();
    const gone = await tool(meta, "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      {},
    );
    // Tombstoned: "it was here and is gone" — distinguishable from never-existed.
    expect(errorCode(gone)).toBe("COMPONENT_UNMOUNTED");
  });

  it("input validation still runs on the registry, not the tool boundary", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry);

    const bad = await tool(meta, "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", input: { ids: [] } },
      {},
    );
    expect(errorCode(bad)).toBe("INVALID_INPUT");
  });

  it("wait-mode confirmation resolves through one surface_act call", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const executor: AgentProcedureExecutor = {
      paths: ["devices.disable"],
      async execute({ input }) {
        return { disabled: (input as { deviceIds: string[] }).deviceIds.length };
      },
    };
    registry.setProcedureExecutor(executor);
    const state = makeDevicesState();
    state.selectedIds = ["d1", "d2"];
    registry.register(devicesTableDefinition(state, { procedures: [disableBinding(state)] }));
    const meta = metaToolset(registry, { confirmations: "wait" });

    const pending = tool(meta, "surface_act").execute(
      { capabilityId: "domain:devices.disable", input: { reason: "maintenance" } },
      {},
    );
    // Approve out of band, exactly as the embedded topology does in direct mode.
    await vi.waitFor(() => {
      expect(registry.confirmations.pending()).toHaveLength(1);
    });
    registry.confirmations.resolve(registry.confirmations.pending()[0]!.confirmationId, {
      approved: true,
    });

    const result = await pending;
    expect(result.status).toBe("ok");
  });

  it("two-phase confirmation surfaces the id and accepts it back", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({
      paths: ["devices.disable"],
      async execute() {
        return { disabled: 1 };
      },
    });
    const state = makeDevicesState();
    state.selectedIds = ["d1"];
    registry.register(devicesTableDefinition(state, { procedures: [disableBinding(state)] }));
    const meta = metaToolset(registry, { confirmations: "two-phase" });

    const first = await tool(meta, "surface_act").execute(
      { capabilityId: "domain:devices.disable", input: { reason: "maintenance" } },
      {},
    );
    expect(errorCode(first)).toBe("CONFIRMATION_REQUIRED");
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    registry.confirmations.resolve(confirmationId, { approved: true });

    const second = await tool(meta, "surface_act").execute(
      { capabilityId: "domain:devices.disable", input: { reason: "maintenance" }, confirmationId },
      {},
    );
    expect(second.status).toBe("ok");
  });

  it("the meta catalog is constant, so subscribers are never notified", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const meta = metaToolset(registry);
    const seen: number[] = [];
    meta.subscribe((tools) => seen.push(tools.length));

    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    handle.unregister();

    expect(seen).toEqual([]);
    expect(meta.tools().map((t) => t.name)).toEqual([
      "surface_discover",
      "surface_read",
      "surface_act",
    ]);
  });
});

describe("configured scope is a floor (AS-ADAPTER-005, D27)", () => {
  function discoveredTypes(result: AgentInvocationResult): string[] {
    if (result.status !== "ok") throw new Error(`discover failed: ${errorCode(result)}`);
    const output = result.output as { components: Array<{ type: string }> };
    return output.components.map((c) => c.type);
  }

  it("a model-supplied scope cannot widen past the configured floor", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry, { scope: ["billing"] });
    const discover = tool(meta, "surface_discover");

    expect(discoveredTypes(await discover.execute({}, {}))).toEqual([]);
    // The three shapes of the widening attempt: empty list, a sibling prefix,
    // and an ancestor of the floor.
    expect(discoveredTypes(await discover.execute({ scope: [] }, {}))).toEqual([]);
    expect(discoveredTypes(await discover.execute({ scope: ["devices"] }, {}))).toEqual([]);
    expect(discoveredTypes(await discover.execute({ scope: ["devices", "billing"] }, {}))).toEqual(
      [],
    );
  });

  it("a model-supplied scope may narrow within the floor", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry, { scope: ["devices"] });
    const discover = tool(meta, "surface_discover");

    expect(discoveredTypes(await discover.execute({}, {}))).toEqual(["devices.table"]);
    expect(discoveredTypes(await discover.execute({ scope: ["devices.table"] }, {}))).toEqual([
      "devices.table",
    ]);
    expect(discoveredTypes(await discover.execute({ scope: ["devices.map"] }, {}))).toEqual([]);
  });

  it("with no floor configured, a model-supplied scope is honored as-is", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry);
    const discover = tool(meta, "surface_discover");

    expect(discoveredTypes(await discover.execute({}, {}))).toEqual(["devices.table"]);
    expect(discoveredTypes(await discover.execute({ scope: ["billing"] }, {}))).toEqual([]);
  });

  it("scope is discovery-only: surface_act reaches out-of-scope capabilities", async () => {
    // Documented, not accidental (docs/09 §scope-is-discovery-only). invoke()
    // never checks scope, in either mode. A least-trusted peer gets `direct`,
    // where no tool exists for what the floor hides.
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));
    const meta = metaToolset(registry, { scope: ["billing"] });

    const act = await tool(meta, "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      {},
    );
    expect(act.status).toBe("ok");

    const direct = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      scope: ["billing"],
    });
    expect(direct.tools()).toHaveLength(0);
  });

  it("a budget is rejected in direct mode rather than silently dropping tools", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    expect(() =>
      createAgentToolset(registry, {
        consumer: { id: "copilot", kind: "embedded" },
        topology: "embedded",
        budget: { maxComponents: 1 },
      }),
    ).toThrow(/mode 'meta' only/);
  });

  it("a meta budget truncates and says so in the payload the model reads", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "a" });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "b" });
    const meta = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      mode: "meta",
      budget: { maxComponents: 1 },
    });

    const result = await tool(meta, "surface_discover").execute({}, {});
    expect(result.status).toBe("ok");
    const output =
      result.status === "ok"
        ? (result.output as { components: unknown[]; truncated?: { droppedComponents: number } })
        : { components: [], truncated: undefined };
    expect(output.components).toHaveLength(1);
    expect(output.truncated).toEqual({ droppedComponents: 1 });
  });
});
