/**
 * Conformance: capability state is structured data, not description text
 * (docs/09 §rendering-capability-state, D28). Requirements:
 * AS-CACHE-001 (no live state in `description` once split),
 * AS-CACHE-002 (tool definitions byte-identical across an availability flip),
 * AS-CACHE-003 (`state.note` carries the binding `describe()` contribution),
 * AS-CACHE-004 (`AgentProcedureDescriptor.description` note-free when the
 * registry stops merging).
 *
 * The point of all four is a stable provider prompt prefix: tool definitions
 * sit at the front of the cached prefix, so a byte that flips when a user
 * clicks re-bills the whole conversation behind it.
 */
import { describe, expect, it } from "vitest";
import {
  createAgentSurfaceRegistry,
  createAgentToolset,
  stableDescriptionOf,
  type AgentSurfaceRegistry,
  type AgentTool,
  type AgentToolset,
} from "@agent-surface/core";
import {
  devicesTableDefinition,
  disableBinding,
  makeDevicesState,
  type DevicesState,
} from "../helpers.js";

/** The bytes a host actually puts in the provider tool block. */
function definitions(toolset: AgentToolset): string {
  return JSON.stringify(
    toolset.tools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
}

function tool(toolset: AgentToolset, name: string): AgentTool {
  const found = toolset.tools().find((t) => t.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function setup(options?: {
  mergesContextualNote?: boolean;
  describe?: () => string;
}): { registry: AgentSurfaceRegistry; state: DevicesState } {
  const registry = createAgentSurfaceRegistry({
    environment: "test",
    ...(options?.mergesContextualNote !== undefined
      ? { snapshotMergesContextualNote: options.mergesContextualNote }
      : {}),
  });
  registry.setProcedureExecutor({
    paths: ["devices.disable"],
    async execute() {
      return { disabled: 1 };
    },
  });
  const state = makeDevicesState();
  registry.register(
    devicesTableDefinition(state, {
      procedures: [
        disableBinding(state, {
          ...(options?.describe ? { describe: options.describe } : {}),
        }),
      ],
    }),
  );
  return { registry, state };
}

describe("AS-CACHE-001 — descriptions carry no live state once split", () => {
  it("drops the [currently unavailable] text and keeps the stable prefix", () => {
    const { registry } = setup();
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      descriptionIncludesState: false,
    });

    const disable = tool(toolset, "domain_devices__disable");
    expect(disable.description).toBe(
      "[domain · destructive · requires confirmation] Disable the given devices",
    );
    expect(disable.description).not.toContain("currently unavailable");
    // The signal is not lost — it moved to where a host can render it.
    expect(disable.state.available).toBe(false);
    expect(disable.state.unavailableReason).toBe("Select at least one device first");

    const clear = tool(toolset, "view_devices__table__clearSelection");
    expect(clear.description).not.toContain("currently unavailable");
    expect(clear.state).toEqual({ available: false, unavailableReason: "No rows are selected" });
  });

  it("keeps 0.1's exact composition while the compat flag is on (the default)", () => {
    const { registry } = setup();
    const legacy = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });
    const disable = tool(legacy, "domain_devices__disable");
    expect(disable.description).toBe(
      "[domain · destructive · requires confirmation] [currently unavailable: Select at least one device first] Disable the given devices",
    );
    // `state` is populated in BOTH modes, so a host can migrate before the
    // default moves.
    expect(disable.state.available).toBe(false);
  });
});

describe("AS-CACHE-002 — tool definitions survive an availability flip byte-identically", () => {
  it("the tool block is unchanged; only `state` moves", async () => {
    const { registry, state } = setup();
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      descriptionIncludesState: false,
    });

    const before = definitions(toolset);
    expect(tool(toolset, "domain_devices__disable").state.available).toBe(false);

    // Exactly the mid-turn event that used to invalidate the prompt prefix:
    // the user selects rows, three capabilities flip availability.
    state.selectedIds = ["d1", "d2"];
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "aux.panel" }));
    await Promise.resolve();

    expect(tool(toolset, "domain_devices__disable").state.available).toBe(true);
    // A new component legitimately adds tools; compare only the ones that were
    // already there, which is what the provider cache is keyed on.
    const after = JSON.parse(definitions(toolset)) as Array<{ name: string }>;
    const kept = JSON.stringify(
      after.filter((t) => !t.name.startsWith("view_aux__panel")),
    );
    expect(kept).toBe(before);
  });

  it("the same flip DOES change the definitions under the compat flag", async () => {
    const { registry, state } = setup();
    const legacy = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });
    const before = definitions(legacy);
    state.selectedIds = ["d1"];
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "aux.panel" }));
    await Promise.resolve();
    expect(definitions(legacy)).not.toBe(before); // the cache miss this RFC removes
  });

  it("subscribers still hear about the flip, so the state block can be re-rendered", async () => {
    const { registry, state } = setup();
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      descriptionIncludesState: false,
    });
    const seen: Array<boolean | undefined> = [];
    toolset.subscribe((tools) => {
      seen.push(tools.find((t) => t.name === "domain_devices__disable")?.state.available);
    });

    state.selectedIds = ["d1"];
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "aux.panel" }));
    await Promise.resolve();

    expect(seen).toContain(true);
  });
});

describe("AS-CACHE-003 — state.note carries the binding describe() contribution", () => {
  it("is exposed as data and kept out of the split description", () => {
    const { registry } = setup({ describe: () => "Currently bound to 2 selected device(s)." });
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      descriptionIncludesState: false,
    });
    const disable = tool(toolset, "domain_devices__disable");
    expect(disable.state.note).toBe("Currently bound to 2 selected device(s).");
    expect(disable.description).not.toContain("Currently bound");
  });

  it("the compat flag still merges it into the description, note and all", () => {
    const { registry } = setup({ describe: () => "Currently bound to 2 selected device(s)." });
    const legacy = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });
    const disable = tool(legacy, "domain_devices__disable");
    expect(disable.description).toContain("Disable the given devices Currently bound to 2");
    expect(disable.state.note).toBe("Currently bound to 2 selected device(s).");
  });

  it("a split toolset is stable even on a registry that still merges", () => {
    // The two flags are independent: a host may adopt the stable tool block
    // before its direct snapshot readers migrate.
    let calls = 0;
    const { registry } = setup({
      mergesContextualNote: true,
      describe: () => `note #${++calls}`,
    });
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      descriptionIncludesState: false,
    });
    expect(tool(toolset, "domain_devices__disable").description).toBe(
      "[domain · destructive · requires confirmation] Disable the given devices",
    );
  });
});

describe("AS-CACHE-004 — the snapshot keeps the two apart when asked", () => {
  it("description is the manifest text; contextualNote is this snapshot's", () => {
    const { registry } = setup({
      mergesContextualNote: false,
      describe: () => "Currently bound to 2 selected device(s).",
    });
    const [procedure] = registry.snapshot().procedures;
    expect(procedure?.description).toBe("Disable the given devices");
    expect(procedure?.contextualNote).toBe("Currently bound to 2 selected device(s).");
  });

  it("merging is the default, and stableDescriptionOf recovers the split either way", () => {
    const merged = setup({
      mergesContextualNote: true,
      describe: () => "Currently bound to 2 selected device(s).",
    }).registry.snapshot().procedures[0];
    const split = setup({
      mergesContextualNote: false,
      describe: () => "Currently bound to 2 selected device(s).",
    }).registry.snapshot().procedures[0];

    expect(merged?.description).toBe(
      "Disable the given devices Currently bound to 2 selected device(s).",
    );
    expect(merged?.contextualNote).toBe(split?.contextualNote);
    expect(stableDescriptionOf(merged!)).toBe("Disable the given devices");
    expect(stableDescriptionOf(split!)).toBe("Disable the given devices");
  });

  it("a procedure with no describe() has no note in either mode", () => {
    for (const mergesContextualNote of [true, false]) {
      const [procedure] = setup({ mergesContextualNote }).registry.snapshot().procedures;
      expect(procedure?.description).toBe("Disable the given devices");
      expect(procedure?.contextualNote).toBeUndefined();
      expect(stableDescriptionOf(procedure!)).toBe("Disable the given devices");
    }
  });
});
