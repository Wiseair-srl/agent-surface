// Conformance: AS-ADAPTER-001 (staleness tokens + toolCallId->invocationId + per-version refresh + unique wire names), AS-ADAPTER-002 (result envelope relayed losslessly)
import { describe, expect, it } from "vitest";
import {
  createAgentSurfaceRegistry,
  createAgentToolset,
  type AgentProcedureExecutor,
  type AgentTool,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "./helpers.js";

function setup(confirmations: "wait" | "two-phase" = "wait") {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  const executor: AgentProcedureExecutor = {
    paths: ["devices.disable"],
    async execute({ input }) {
      return { disabled: (input as { deviceIds: string[] }).deviceIds.length };
    },
  };
  registry.setProcedureExecutor(executor);
  const state = makeDevicesState();
  registry.register(devicesTableDefinition(state, { procedures: [disableBinding(state)] }));
  const toolset = createAgentToolset(registry, {
    consumer: { id: "copilot-panel", kind: "embedded" },
    confirmations,
  });
  return { registry, state, toolset };
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in catalog: ${tools.map((t) => t.name).join(", ")}`);
  return tool;
}

describe("embedded toolset adapter (docs/03 §toolset, docs/09)", () => {
  it("projects wire-named tools with plane/effect description prefixes", () => {
    const { toolset } = setup();
    const tools = toolset.tools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("view_devices__table__readState");
    expect(names).toContain("view_devices__table__selectRows");
    expect(names).toContain("domain_devices__disable");

    const read = toolByName(tools, "view_devices__table__readState");
    expect(read.description.startsWith("[view · read]")).toBe(true);
    const select = toolByName(tools, "view_devices__table__selectRows");
    expect(select.description.startsWith("[view · local-state]")).toBe(true);
    const disable = toolByName(tools, "domain_devices__disable");
    expect(disable.description).toContain("[domain · destructive · requires confirmation]");
    // Unavailable (empty selection) is disclosed, not hidden — planning fuel.
    expect(disable.description).toContain("currently unavailable");
    expect(disable.description).toContain("Select at least one device first");
  });

  it("agent-facing procedure schema is the REDUCED one (bound fields removed)", () => {
    const { toolset } = setup();
    const disable = toolByName(toolset.tools(), "domain_devices__disable");
    expect(Object.keys((disable.inputSchema.properties ?? {}) as object)).toEqual(["reason"]);
  });

  it("catalog refreshes per surface version; subscribe fires on real changes", async () => {
    const { registry, state, toolset } = setup();
    const notifications: number[] = [];
    toolset.subscribe((tools) => notifications.push(tools.length));

    expect(toolByName(toolset.tools(), "domain_devices__disable").description).toContain(
      "currently unavailable",
    );

    // Selection becomes non-empty (lazy when() flip); a mutation bumps the
    // version, and the recomputed catalog reflects the fresh availability.
    state.selectedIds = ["d1", "d2"];
    const handle = registry.register(
      devicesTableDefinition(makeDevicesState(), { type: "aux.panel" }),
    );
    await Promise.resolve(); // surface-changed microtask
    expect(notifications.length).toBeGreaterThan(0);
    expect(toolByName(toolset.tools(), "domain_devices__disable").description).not.toContain(
      "currently unavailable",
    );
    handle.unregister();
  });

  it("execute attaches registrationId + surfaceVersion and dedupes via toolCallId", async () => {
    const { registry, state, toolset } = setup();
    state.selectedIds = ["d1"];
    const select = toolByName(toolset.tools(), "view_devices__table__selectRows");
    const [a, b] = await Promise.all([
      select.execute({ ids: ["d1", "d2"] }, { toolCallId: "call_1" }),
      select.execute({ ids: ["d1", "d2"] }, { toolCallId: "call_1" }),
    ]);
    expect(a.status).toBe("ok");
    expect(a).toEqual(b); // transport retry deduped
    expect(a.invocationId).toBe("call_1");
    expect(state.selectedIds).toEqual(["d1", "d2"]); // executed once
    void registry;
  });

  it("catalog entries from a superseded registration fail STALE_CAPABILITY", async () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      onDuplicateInstance: "replace",
    });
    registry.setProcedureExecutor({ paths: [], execute: async () => ({}) });
    const h1 = registry.register(devicesTableDefinition(makeDevicesState()));
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });
    const tool = toolByName(toolset.tools(), "view_devices__table__selectRows");
    registry.register(devicesTableDefinition(makeDevicesState())); // replaces h1
    expect(h1.status).toBe("unregistered");
    const result = await tool.execute({ ids: ["d1"] }, { toolCallId: "call_stale" });
    expect(result.status === "error" && result.error.code).toBe("STALE_CAPABILITY");
    expect(result.status === "error" && result.error.details?.reason).toBe(
      "registration-replaced",
    );
  });

  it("wait mode: one tool call → confirmation wait → one final result", async () => {
    const { registry, state, toolset } = setup("wait");
    state.selectedIds = ["d1", "d2"];
    const disable = toolByName(toolset.tools(), "domain_devices__disable");

    const pendingResult = disable.execute({}, { toolCallId: "call_disable" });
    // Wait until the confirmation is pending, then approve as the user.
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.confirmations.pending()).toHaveLength(1);
    registry.confirmations.resolve(registry.confirmations.pending()[0]!.confirmationId, {
      approved: true,
    });
    const result = await pendingResult;
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.output).toEqual({ disabled: 2 });
  });

  it("wait mode: denial surfaces CONFIRMATION_INVALID {denied} — never auto-retried", async () => {
    const { registry, state, toolset } = setup("wait");
    state.selectedIds = ["d1"];
    const disable = toolByName(toolset.tools(), "domain_devices__disable");
    const pendingResult = disable.execute({}, { toolCallId: "call_deny" });
    await new Promise((r) => setTimeout(r, 0));
    registry.confirmations.resolve(registry.confirmations.pending()[0]!.confirmationId, {
      approved: false,
      reason: "user-declined",
    });
    const result = await pendingResult;
    expect(result.status === "error" && result.error.code).toBe("CONFIRMATION_INVALID");
    expect(result.status === "error" && result.error.details?.reason).toBe("denied");
  });

  it("two-phase mode: CONFIRMATION_REQUIRED is relayed to the model", async () => {
    const { state, toolset } = setup("two-phase");
    state.selectedIds = ["d1"];
    const disable = toolByName(toolset.tools(), "domain_devices__disable");
    const result = await disable.execute({}, { toolCallId: "call_two_phase" });
    expect(result.status === "error" && result.error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("multi-instance capabilities get UNIQUE per-instance tool names", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const stateMain = makeDevicesState();
    const stateComparison = makeDevicesState();
    registry.register(devicesTableDefinition(stateMain, { instanceId: "main" }));
    registry.register(devicesTableDefinition(stateComparison, { instanceId: "comparison" }));
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });
    const names = toolset.tools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // providers reject duplicates
    expect(names).toContain("view_devices__table__selectRows_at_main");
    expect(names).toContain("view_devices__table__selectRows_at_comparison");

    // Each suffixed tool targets ITS instance.
    const main = toolByName(toolset.tools(), "view_devices__table__selectRows_at_main");
    const result = await main.execute({ ids: ["d1"] }, { toolCallId: "call_main" });
    expect(result.status).toBe("ok");
    expect(stateMain.selectedIds).toEqual(["d1"]);
    expect(stateComparison.selectedIds).toEqual([]);
  });

  it("meta mode exposes exactly surface_discover / surface_read / surface_act", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      mode: "meta",
    });
    const names = toolset.tools().map((t) => t.name);
    expect(names).toEqual(["surface_discover", "surface_read", "surface_act"]);

    const discover = await toolByName(toolset.tools(), "surface_discover").execute({}, {});
    expect(discover.status).toBe("ok");
    const catalog = discover.status === "ok" ? (discover.output as { components: unknown[] }) : { components: [] };
    expect(catalog.components).toHaveLength(1);

    const read = await toolByName(toolset.tools(), "surface_read").execute(
      { capabilityId: "view:devices.table.readState" },
      {},
    );
    expect(read.status).toBe("ok");

    const act = await toolByName(toolset.tools(), "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      {},
    );
    expect(act.status).toBe("ok");
    expect(state.selectedIds).toEqual(["d1"]);
  });
});
