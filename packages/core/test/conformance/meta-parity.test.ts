/**
 * Conformance: meta-tools mode preserves the direct-mode contract (docs/09
 * §meta-tools-mode). Requirements: AS-ADAPTER-004 (resolution parity),
 * AS-ADAPTER-005 (configured scope is a floor, D27).
 *
 * D29 graduated the mode from Experimental to supported; the suite that made
 * that defensible is below — AS-META-001 (a model scope narrows the floor),
 * AS-META-002 (a disjoint scope yields empty, never the floor), AS-META-003
 * (budget truncation is marked in the payload the model reads), AS-META-004
 * (`surface_act` keeps direct-mode confirmation and staleness semantics),
 * AS-META-005 (tool-block size is invariant in the catalog size).
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

  it("AS-META-001: a model-supplied scope cannot widen past the configured floor", async () => {
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

  it("AS-META-001: a model-supplied scope may narrow within the floor", async () => {
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

  it("AS-META-002: a disjoint requested scope yields empty, never the floor", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "billing.invoices" }));
    const meta = metaToolset(registry, { scope: ["devices"] });
    const discover = tool(meta, "surface_discover");

    // Falling back to the floor would silently hand back `devices.table` —
    // the model would then plan against a surface it did not ask for.
    expect(discoveredTypes(await discover.execute({ scope: ["billing"] }, {}))).toEqual([]);
    expect(discoveredTypes(await discover.execute({ scope: ["nothing.here"] }, {}))).toEqual([]);
    // …and the floor is still there for the next, non-disjoint request.
    expect(discoveredTypes(await discover.execute({ scope: ["devices"] }, {}))).toEqual([
      "devices.table",
    ]);
  });

  function scopeRejected(result: AgentInvocationResult): string[] | undefined {
    if (result.status !== "ok") throw new Error(`discover failed: ${errorCode(result)}`);
    return (result.output as { scopeRejected?: { prefixes: string[] } }).scopeRejected?.prefixes;
  }

  it("AS-META-006: a floor that refuses the whole request says so in the payload", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry, { scope: ["devices"] });
    const discover = tool(meta, "surface_discover");

    // Without the marker this payload is indistinguishable from an empty
    // surface, and the two call for opposite next moves: ask again unscoped,
    // versus stop asking. Same reason budget truncation is marked (AS-META-003).
    const result = await discover.execute({ scope: ["billing"] }, {});
    expect(discoveredTypes(result)).toEqual([]);
    expect(scopeRejected(result)).toEqual(["billing"]);
  });

  it("AS-META-006: a genuinely empty surface is distinguishable from a refused scope", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const meta = metaToolset(registry, { scope: ["devices"] });
    const discover = tool(meta, "surface_discover");

    // Nothing mounted: empty, and nothing was refused to make it so.
    const empty = await discover.execute({ scope: ["devices.table"] }, {});
    expect(discoveredTypes(empty)).toEqual([]);
    expect(scopeRejected(empty)).toBeUndefined();

    registry.register(devicesTableDefinition(makeDevicesState()));
    const refused = await discover.execute({ scope: ["billing"] }, {});
    expect(discoveredTypes(refused)).toEqual([]);
    expect(scopeRejected(refused)).toEqual(["billing"]);
  });

  it("AS-META-006: partial refusal is reported alongside the part that was admitted", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry, { scope: ["devices"] });

    // The admitted half returning results is not evidence the other half
    // existed and was empty — it was never looked at.
    const result = await tool(meta, "surface_discover").execute(
      { scope: ["devices.table", "billing", "billing"] },
      {},
    );
    expect(discoveredTypes(result)).toEqual(["devices.table"]);
    expect(scopeRejected(result)).toEqual(["billing"]);
  });

  it("AS-META-006: a refused scope does not inherit a budget's truncation count", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "a" });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "b" });
    const meta = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      mode: "meta",
      scope: ["devices"],
      budget: { maxComponents: 1 },
    });

    // A disjoint request is snapshotted unscoped, so the budget does drop a
    // component on the way — but of a surface this payload does not contain.
    // Reporting it would blame the budget for what the floor did.
    const result = await tool(meta, "surface_discover").execute({ scope: ["billing"] }, {});
    expect(result.status).toBe("ok");
    const output =
      result.status === "ok"
        ? (result.output as { components: unknown[]; truncated?: unknown })
        : { components: ["unreachable"], truncated: "unreachable" };
    expect(output.components).toEqual([]);
    expect(output.truncated).toBeUndefined();
    expect(scopeRejected(result)).toEqual(["billing"]);
  });

  it("AS-META-006: honored requests carry no marker", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const floored = metaToolset(registry, { scope: ["devices"] });
    const discover = tool(floored, "surface_discover");

    // No request, and a request inside the floor.
    expect(scopeRejected(await discover.execute({}, {}))).toBeUndefined();
    expect(scopeRejected(await discover.execute({ scope: ["devices.table"] }, {}))).toBeUndefined();

    // A request *broader* than the floor is not a refusal: it collapses to the
    // floor's own prefix, which is the narrowing D27 specifies.
    const narrow = metaToolset(registry, { scope: ["devices.table"] });
    const broad = await tool(narrow, "surface_discover").execute({ scope: ["devices"] }, {});
    expect(discoveredTypes(broad)).toEqual(["devices.table"]);
    expect(scopeRejected(broad)).toBeUndefined();

    // With no floor there is nothing to refuse: an empty result means empty.
    const unfloored = tool(metaToolset(registry), "surface_discover");
    expect(scopeRejected(await unfloored.execute({ scope: ["billing"] }, {}))).toBeUndefined();
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

  it("AS-META-003: a meta budget truncates and says so in the payload the model reads", async () => {
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

  it("AS-META-003: a truncated discover payload is still a valid snapshot", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({ paths: ["devices.disable"], execute: async () => ({}) });
    const state = makeDevicesState();
    registry.register({
      ...devicesTableDefinition(state, { procedures: [disableBinding(state)] }),
      instanceId: "a",
    });
    registry.register({ ...devicesTableDefinition(makeDevicesState()), instanceId: "b" });
    const meta = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      mode: "meta",
      budget: { maxComponents: 1 },
    });

    const result = await tool(meta, "surface_discover").execute({}, {});
    // Truncation drops components; it must not leave the model a half-object
    // it cannot plan against.
    const payload = result.status === "ok" ? (result.output as Record<string, unknown>) : {};
    expect(Object.keys(payload).sort()).toEqual(
      ["capturedAt", "components", "procedures", "surfaceId", "surfaceVersion", "truncated"].sort(),
    );
    for (const component of payload.components as Array<Record<string, unknown>>) {
      expect(Object.keys(component)).toEqual(
        expect.arrayContaining([
          "type",
          "instanceId",
          "registrationId",
          "description",
          "observations",
          "actions",
        ]),
      );
    }
    // Procedures survive their component being dropped — they are top-level,
    // and each still carries the registrationId an act must send back.
    for (const procedure of payload.procedures as Array<Record<string, unknown>>) {
      expect(typeof procedure.registrationId).toBe("string");
      expect(typeof procedure.procedureId).toBe("string");
    }
  });

  it("AS-META-004: a destructive act against a surface that moved is rejected, as in direct mode", async () => {
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

    // What the model saw when it planned the destructive step.
    const discovered = registry.getVersion();
    // …and the page moved underneath it.
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "aux.panel" }));
    expect(registry.getVersion()).not.toBe(discovered);

    const result = await tool(meta, "surface_act").execute(
      {
        capabilityId: "domain:devices.disable",
        input: { reason: "maintenance" },
        surfaceVersion: discovered,
      },
      { toolCallId: "call_meta_stale" },
    );
    expect(errorCode(result)).toBe("STALE_CAPABILITY");
    expect(result.status === "error" && result.error.details?.reason).toBe(
      "surface-version-mismatch",
    );

    // Direct mode reaches the same verdict from a catalog captured then.
    const direct = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      confirmations: "two-phase",
    });
    const captured = direct.tools().find((t) => t.name === "domain_devices__disable")!;
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "aux.two" }));
    expect(errorCode(await captured.execute({ reason: "maintenance" }, { toolCallId: "d1" }))).toBe(
      "STALE_CAPABILITY",
    );
  });

  it("AS-META-004: an omitted surfaceVersion still resolves against the live surface", async () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      onDuplicateInstance: "replace",
    });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = metaToolset(registry);

    registry.register(devicesTableDefinition(makeDevicesState())); // replaces
    expect(handle.status).toBe("unregistered");

    // Resolution is re-run per call, so a local-state act picks up the LIVE
    // registration instead of replaying a dead one.
    const result = await tool(meta, "surface_act").execute(
      { capabilityId: "view:devices.table.selectRows", input: { ids: ["d1"] } },
      { toolCallId: "call_meta_live" },
    );
    expect(result.status).toBe("ok");
  });

  it("AS-META-005: the tool block does not grow with the catalog", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const meta = metaToolset(registry);
    const blockSize = (): number => JSON.stringify(
      meta.tools().map((t) => [t.name, t.description, t.inputSchema]),
    ).length;

    const empty = blockSize();
    for (let i = 0; i < 60; i++) {
      registry.register(
        devicesTableDefinition(makeDevicesState(), {
          type: `feature${i}.panel`,
          instanceId: `i${i}`,
        }),
      );
    }
    // 60 components, ~180 capabilities: a direct catalog would be ~180 tools.
    expect(registry.snapshot().components.length).toBe(60);
    expect(meta.tools()).toHaveLength(3);
    expect(blockSize()).toBe(empty);
  });
});
