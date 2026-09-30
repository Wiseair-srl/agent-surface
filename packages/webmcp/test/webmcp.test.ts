// Conformance: AS-ADAPTER-003 (feature-detect, unavailable-not-registered, refresh on version),
// AS-AUTHORITY-004, AS-ADAPTER-006 (stop withdraws tools), AS-ADAPTER-007 (incremental
// registration), AS-ADAPTER-008 (in-page confirmation), AS-ADAPTER-009 (readOnlyHint).
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  observation,
  type AgentProcedureBinding,
  type AgentProcedureExecutor,
  type JsonSchema,
} from "@agent-surface/core";
import {
  createWebMcpAdapter,
  type WebMcpClient,
  type WebMcpModelContext,
  type WebMcpToolInit,
} from "@agent-surface/webmcp";

function makeMockModelContext(): WebMcpModelContext & { provided: WebMcpToolInit[][] } {
  const provided: WebMcpToolInit[][] = [];
  return {
    provided,
    provideContext(context) {
      provided.push(context.tools);
    },
  };
}

const anyObject = fromJsonSchema({ type: "object", additionalProperties: true });

function makeRegistry(selected: { ids: string[] }) {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  registry.register(
    defineAgentComponent({
      type: "devices.table",
      description: "Devices table",
      observations: {
        readState: observation({
          description: "Visible rows",
          output: anyObject,
          read: () => ({ selectedIds: selected.ids }),
        }),
      },
      actions: {
        selectRows: action({
          description: "Select rows",
          input: fromJsonSchema<{ ids: string[] }>({
            type: "object",
            properties: { ids: { type: "array", items: { type: "string" } } },
            required: ["ids"],
            additionalProperties: false,
          }),
          effect: "local-state",
          execute: ({ ids }) => {
            selected.ids = ids;
          },
        }),
        clearSelection: action({
          description: "Clear",
          input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
          effect: "local-state",
          when: () => selected.ids.length > 0,
          unavailableReason: "Nothing selected",
          execute: () => {
            selected.ids = [];
          },
        }),
      },
    }),
  );
  return registry;
}

describe("WebMCP adapter (docs/09, Experimental)", () => {
  it("start() is a no-op when navigator.modelContext is absent (feature-detect, never polyfill)", () => {
    const registry = makeRegistry({ ids: [] });
    const adapter = createWebMcpAdapter();
    expect(() =>
      adapter.start({ registry, consumer: { id: "webmcp", kind: "webmcp" } }),
    ).not.toThrow();
    adapter.stop();
  });

  it("registers one wire-named tool per AVAILABLE capability; unavailable are absent", () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer: { id: "webmcp", kind: "webmcp" } });

    const names = modelContext.provided.at(-1)!.map((t) => t.name);
    expect(names).toContain("view_devices__table__readState");
    expect(names).toContain("view_devices__table__selectRows");
    // clearSelection is unavailable (empty selection) ⇒ not registered on
    // this transport (WebMCP has no disabled state today).
    expect(names).not.toContain("view_devices__table__clearSelection");
    adapter.stop();
  });

  it("re-provides the catalog on surface-changed", async () => {
    const selected = { ids: [] as string[] };
    const registry = makeRegistry(selected);
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer: { id: "webmcp", kind: "webmcp" } });
    const initialProvides = modelContext.provided.length;

    registry.register(
      defineAgentComponent({ type: "aux.panel", description: "Aux panel" }),
    );
    await Promise.resolve(); // surface-changed microtask
    expect(modelContext.provided.length).toBeGreaterThan(initialProvides);
    adapter.stop();
  });

  it("execute maps ok results and capability errors into tool CONTENT, never protocol errors", async () => {
    const selected = { ids: [] as string[] };
    const registry = makeRegistry(selected);
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer: { id: "webmcp", kind: "webmcp" } });

    const tools = modelContext.provided.at(-1)!;
    const select = tools.find((t) => t.name === "view_devices__table__selectRows")!;
    const ok = await select.execute({ ids: ["d1"] });
    expect(ok.isError).toBeUndefined();
    expect(selected.ids).toEqual(["d1"]);

    const bad = await select.execute({ ids: "nope" } as never);
    expect(bad.isError).toBe(true);
    const payload = JSON.parse(bad.content[0]!.text) as { code: string; retry: string };
    expect(payload.code).toBe("INVALID_INPUT");
    expect(payload.retry).toBe("with-changes");
    adapter.stop();
  });

  it("exposeCapability curation hook can skip capabilities", () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({
      modelContext,
      exposeCapability: (descriptor) =>
        "capabilityId" in descriptor && descriptor.capabilityId.includes("selectRows")
          ? null
          : undefined,
    });
    adapter.start({ registry, consumer: { id: "webmcp", kind: "webmcp" } });
    const names = modelContext.provided.at(-1)!.map((t) => t.name);
    expect(names).not.toContain("view_devices__table__selectRows");
    expect(names).toContain("view_devices__table__readState");
    adapter.stop();
  });

  it("ignores attempted execute overrides and routes through registry", async () => {
    const selected = { ids: [] as string[] };
    const modelContext = makeMockModelContext();
    let rogueCalled = false;
    const adapter = createWebMcpAdapter({
      modelContext,
      exposeCapability: () =>
        ({
          description: "Curated",
          execute: async () => {
            rogueCalled = true;
            return { content: [] };
          },
        }) as never,
    });
    adapter.start({
      registry: makeRegistry(selected),
      consumer: { id: "webmcp", kind: "webmcp" },
    });
    const select = modelContext.provided
      .at(-1)!
      .find((tool) => tool.name === "view_devices__table__selectRows")!;
    await select.execute({ ids: ["d1"] });
    expect(selected.ids).toEqual(["d1"]);
    expect(rogueCalled).toBe(false);
    expect(select.description).toBe("Curated");
    adapter.stop();
  });

  it("stop() unsubscribes: no further provides after surface changes", async () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer: { id: "webmcp", kind: "webmcp" } });
    adapter.stop();
    const count = modelContext.provided.length;
    registry.register(defineAgentComponent({ type: "aux.panel", description: "Aux" }));
    await Promise.resolve();
    expect(modelContext.provided.length).toBe(count);
  });
});

/* ───────────── incremental API, stop(), confirmation, annotations ───────────── */

interface Call {
  op: "register" | "unregister" | "provide" | "clear";
  name?: string;
}

/** A modelContext with the incremental API and clearContext, tracking the live set. */
function makeIncrementalModelContext(): Required<WebMcpModelContext> & {
  live: Map<string, WebMcpToolInit>;
  calls: Call[];
} {
  const live = new Map<string, WebMcpToolInit>();
  const calls: Call[] = [];
  return {
    live,
    calls,
    provideContext({ tools }) {
      calls.push({ op: "provide" });
      live.clear();
      for (const tool of tools) live.set(tool.name, tool);
    },
    clearContext() {
      calls.push({ op: "clear" });
      live.clear();
    },
    registerTool(tool) {
      calls.push({ op: "register", name: tool.name });
      if (live.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
      live.set(tool.name, tool);
    },
    unregisterTool(name) {
      calls.push({ op: "unregister", name });
      if (!live.delete(name)) throw new Error(`unknown tool ${name}`);
    },
  };
}

const consumer = { id: "webmcp", kind: "webmcp" } as const;
const emptyObject: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

function procedureBinding(
  id: string,
  effect: "server-query" | "destructive",
  confirmation?: "required",
): AgentProcedureBinding {
  return {
    kind: "procedure-binding",
    ref: {
      id,
      path: id.slice("domain:".length),
      description: `Procedure ${id}`,
      inputSchema: emptyObject,
      outputSchema: { type: "object", additionalProperties: true },
      effect,
      ...(confirmation ? { confirmation } : {}),
    },
    config: {},
    boundKeys: [],
    lockedKeys: [],
    reducedInputSchema: emptyObject,
  } as AgentProcedureBinding;
}

describe("WebMCP adapter: stop() withdraws exposed tools", () => {
  it("clearContext() on the provideContext path; repeated stop() is safe", () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeIncrementalModelContext();
    const provideOnly: WebMcpModelContext = {
      provideContext: modelContext.provideContext,
      clearContext: modelContext.clearContext,
    };
    const adapter = createWebMcpAdapter({ modelContext: provideOnly });
    adapter.start({ registry, consumer });
    expect(modelContext.live.size).toBeGreaterThan(0);

    adapter.stop();
    expect(modelContext.live.size).toBe(0);
    expect(() => adapter.stop()).not.toThrow();
    expect(modelContext.calls.filter((c) => c.op === "clear")).toHaveLength(1);
  });

  it("provides an empty tool set when clearContext is absent", () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    adapter.stop();
    expect(modelContext.provided.at(-1)).toEqual([]);
    adapter.stop();
    expect(modelContext.provided.at(-1)).toEqual([]);
  });

  it("unregisters only its own tools on the incremental path", () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeIncrementalModelContext();
    const foreign: WebMcpToolInit = {
      name: "page_owned_tool",
      description: "Registered by other page code",
      inputSchema: emptyObject,
      execute: async () => ({ content: [] }),
    };
    modelContext.registerTool(foreign);
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    adapter.stop();
    adapter.stop();
    expect([...modelContext.live.keys()]).toEqual(["page_owned_tool"]);
  });

  it("can start again after stop()", () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    adapter.stop();
    adapter.start({ registry, consumer });
    expect(modelContext.live.has("view_devices__table__readState")).toBe(true);
    adapter.stop();
  });
});

describe("WebMCP adapter: incremental registration", () => {
  it("mount/unmount churn yields minimal register/unregister calls", async () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    expect(modelContext.calls.every((c) => c.op === "register")).toBe(true);
    expect([...modelContext.live.keys()].sort()).toEqual([
      "view_devices__table__readState",
      "view_devices__table__selectRows",
    ]);
    modelContext.calls.length = 0;

    const panel = defineAgentComponent({
      type: "aux.panel",
      description: "Aux panel",
      observations: {
        readText: observation({ description: "Panel text", output: anyObject, read: () => ({}) }),
      },
    });
    const handle = registry.register(panel);
    await Promise.resolve();
    // Only the new tool is registered; the devices tools are untouched.
    expect(modelContext.calls).toEqual([{ op: "register", name: "view_aux__panel__readText" }]);
    modelContext.calls.length = 0;

    handle.unregister();
    await Promise.resolve();
    expect(modelContext.calls).toEqual([{ op: "unregister", name: "view_aux__panel__readText" }]);
    expect(modelContext.calls.some((c) => c.op === "provide")).toBe(false);
    adapter.stop();
  });

  it("final set equals the available capabilities as availability flips", async () => {
    const selected = { ids: [] as string[] };
    const registry = makeRegistry(selected);
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });

    const select = modelContext.live.get("view_devices__table__selectRows")!;
    await select.execute({ ids: ["d1"] });
    registry.register(defineAgentComponent({ type: "aux.panel", description: "Aux" }));
    await Promise.resolve();

    const expected = registry
      .snapshot({ consumer, includeUnavailable: false })
      .components.flatMap((c) => [...c.observations, ...c.actions])
      .filter((d) => d.available)
      .map((d) => d.capabilityId.replace(":", "_").replaceAll(".", "__"))
      .sort();
    expect([...modelContext.live.keys()].sort()).toEqual(expected);
    expect(expected).toContain("view_devices__table__clearSelection");
    adapter.stop();
  });

  it("re-registers a tool whose registration changed; surviving tools echo the latest surfaceVersion", async () => {
    const selected = { ids: [] as string[] };
    const registry = makeRegistry(selected);
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    const before = modelContext.live.get("view_devices__table__selectRows")!;

    registry.register(defineAgentComponent({ type: "aux.panel", description: "Aux" }));
    await Promise.resolve();
    // Same registration, same schema/description ⇒ same tool object, no churn.
    expect(modelContext.live.get("view_devices__table__selectRows")).toBe(before);

    const invokeSpy: string[] = [];
    const original = registry.invoke.bind(registry);
    registry.invoke = ((request, ctx) => {
      invokeSpy.push(String(request.surfaceVersion));
      return original(request, ctx);
    }) as typeof registry.invoke;
    await before.execute({ ids: ["d2"] });
    expect(invokeSpy).toEqual([
      registry.snapshot({ consumer, includeUnavailable: false }).surfaceVersion,
    ]);
    adapter.stop();
  });

  it("falls back to provideContext when the incremental API is absent", async () => {
    const registry = makeRegistry({ ids: [] });
    const modelContext = makeMockModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    registry.register(defineAgentComponent({ type: "aux.panel", description: "Aux" }));
    await Promise.resolve();
    expect(modelContext.provided.length).toBe(2);
    adapter.stop();
  });
});

function makeConfirmRegistry() {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  const cleared = { value: false };
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
            cleared.value = true;
          },
        }),
      },
    }),
  );
  return { registry, cleared };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const interactiveClient: WebMcpClient = {
  requestUserInteraction: (callback) => callback(),
};

describe("WebMCP adapter: in-page confirmation via requestUserInteraction", () => {
  it("approval in page completes the registry's confirmation within one tool call", async () => {
    const { registry, cleared } = makeConfirmRegistry();
    const modelContext = makeIncrementalModelContext();
    const seen: string[] = [];
    const adapter = createWebMcpAdapter({
      modelContext,
      confirm: (request) => {
        seen.push(request.capabilityId);
        return true;
      },
    });
    adapter.start({ registry, consumer });
    const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
    const result = await tool.execute({}, interactiveClient);
    expect(result.isError).toBeUndefined();
    expect(cleared.value).toBe(true);
    expect(seen).toEqual(["view:draft.editor.clearDraft"]);
    expect(registry.confirmations.pending()).toEqual([]);
    adapter.stop();
  });

  it("denial in page is decided by the registry and nothing executes", async () => {
    const { registry, cleared } = makeConfirmRegistry();
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({ modelContext, confirm: async () => false });
    adapter.start({ registry, consumer });
    const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
    const result = await tool.execute({}, interactiveClient);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as { code: string };
    expect(payload.code).toBe("CONFIRMATION_INVALID");
    expect(cleared.value).toBe(false);
    adapter.stop();
  });

  it("without a confirm option or client support, waits for the host's confirmation UI", async () => {
    for (const setup of [
      { confirm: undefined, client: interactiveClient },
      { confirm: () => true, client: {} as WebMcpClient },
      { confirm: () => true, client: undefined },
    ]) {
      const { registry, cleared } = makeConfirmRegistry();
      const modelContext = makeIncrementalModelContext();
      const adapter = createWebMcpAdapter({
        modelContext,
        ...(setup.confirm ? { confirm: setup.confirm } : {}),
      });
      adapter.start({ registry, consumer });
      const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
      const call = tool.execute({}, setup.client);
      await tick();
      expect(cleared.value).toBe(false);
      const pending = registry.confirmations.pending();
      expect(pending).toHaveLength(1);
      registry.confirmations.resolve(pending[0]!.confirmationId, { approved: true });
      const result = await call;
      expect(result.isError).toBeUndefined();
      expect(cleared.value).toBe(true);
      // The retry consumed the evidence instead of opening a new confirmation.
      expect(registry.confirmations.pending()).toEqual([]);
      adapter.stop();
    }
  });

  it("a failing in-page UI falls back to the host's confirmation UI", async () => {
    const { registry, cleared } = makeConfirmRegistry();
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({
      modelContext,
      confirm: () => {
        throw new Error("dialog crashed");
      },
    });
    adapter.start({ registry, consumer });
    const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
    const call = tool.execute({}, interactiveClient);
    await tick();
    registry.confirmations.resolve(registry.confirmations.pending()[0]!.confirmationId, {
      approved: true,
    });
    expect((await call).isError).toBeUndefined();
    expect(cleared.value).toBe(true);
    adapter.stop();
  });

  it("host denial or expiry while waiting: CONFIRMATION_INVALID, nothing executes", async () => {
    for (const settle of ["denied", "expired"] as const) {
      const { registry, cleared } = makeConfirmRegistry();
      const modelContext = makeIncrementalModelContext();
      const adapter = createWebMcpAdapter({ modelContext });
      adapter.start({ registry, consumer });
      const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
      const call = tool.execute({});
      await tick();
      const id = registry.confirmations.pending()[0]!.confirmationId;
      if (settle === "denied") registry.confirmations.resolve(id, { approved: false });
      else registry.confirmations.forceExpire(id);
      const payload = JSON.parse((await call).content[0]!.text) as {
        code: string;
        details: { reason: string };
      };
      expect(payload.code).toBe("CONFIRMATION_INVALID");
      expect(payload.details.reason).toBe(settle);
      expect(cleared.value).toBe(false);
      adapter.stop();
    }
  });

  it("stop() while waiting returns CONFIRMATION_REQUIRED; a late approval executes nothing", async () => {
    const { registry, cleared } = makeConfirmRegistry();
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({ modelContext });
    adapter.start({ registry, consumer });
    const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
    const call = tool.execute({});
    await tick();
    adapter.stop();
    const payload = JSON.parse((await call).content[0]!.text) as { code: string };
    expect(payload.code).toBe("CONFIRMATION_REQUIRED");
    registry.confirmations.resolve(registry.confirmations.pending()[0]!.confirmationId, {
      approved: true,
    });
    await tick();
    expect(cleared.value).toBe(false);
  });

  it("stop() during the prompt does not resolve or execute", async () => {
    const { registry, cleared } = makeConfirmRegistry();
    const modelContext = makeIncrementalModelContext();
    const adapter = createWebMcpAdapter({
      modelContext,
      confirm: () => {
        adapter.stop();
        return true;
      },
    });
    adapter.start({ registry, consumer });
    const tool = modelContext.live.get("view_draft__editor__clearDraft")!;
    const result = await tool.execute({}, interactiveClient);
    const payload = JSON.parse(result.content[0]!.text) as { code: string };
    expect(payload.code).toBe("CONFIRMATION_REQUIRED");
    expect(cleared.value).toBe(false);
    expect(registry.confirmations.pending()).toHaveLength(1);
  });
});

describe("WebMCP adapter: annotations.readOnlyHint", () => {
  it("sets readOnlyHint for observations and read-only effects only", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const executor: AgentProcedureExecutor = {
      paths: ["devices.list", "devices.disable"],
      async execute() {
        return {};
      },
    };
    registry.setProcedureExecutor(executor);
    registry.register(
      defineAgentComponent({
        type: "devices.table",
        description: "Devices table",
        observations: {
          readState: observation({ description: "Rows", output: anyObject, read: () => ({}) }),
        },
        actions: {
          selectRows: action({
            description: "Select rows",
            input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
            effect: "local-state",
            execute: () => {},
          }),
          open: action({
            description: "Open details",
            input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
            effect: "navigation",
            execute: () => {},
          }),
        },
        procedures: [
          procedureBinding("domain:devices.list", "server-query"),
          procedureBinding("domain:devices.disable", "destructive"),
        ],
      }),
    );
    const modelContext = makeIncrementalModelContext();
    // A curation hook replaces presentation only; it cannot widen to read-only.
    const adapter = createWebMcpAdapter({
      modelContext,
      exposeCapability: () => ({ description: "curated", annotations: { readOnlyHint: true } }) as never,
    });
    adapter.start({ registry, consumer });

    const hints = Object.fromEntries(
      [...modelContext.live.values()].map((tool) => [tool.name, tool.annotations?.readOnlyHint ?? false]),
    );
    expect(hints).toEqual({
      view_devices__table__readState: true,
      view_devices__table__selectRows: false,
      view_devices__table__open: false,
      domain_devices__list: true,
      domain_devices__disable: false,
    });
    adapter.stop();
  });
});
