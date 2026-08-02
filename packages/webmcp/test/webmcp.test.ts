// Conformance: AS-ADAPTER-003 (feature-detect, unavailable-not-registered, refresh on version),
// AS-AUTHORITY-004.
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  observation,
} from "@agent-surface/core";
import {
  createWebMcpAdapter,
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
