/**
 * Conformance: wire names fit the provider budget and never lose the canonical
 * identity (docs/09 §wire-names, D30). Requirements:
 * AS-WIRE-004 (≤ 64 chars always), AS-WIRE-005 (deterministic across
 * snapshots), AS-WIRE-006 (no collisions within one emitted catalog),
 * AS-WIRE-007 (`wireNameMap()` round-trips every emitted name).
 *
 * The failure this prevents is silent from the library's side: a provider
 * rejects the request, or the host's reverse mapping degrades the canonical id
 * to the wire name and takes the audit identity with it.
 */
import { describe, expect, it } from "vitest";
import {
  assignWireNames,
  createAgentSurfaceRegistry,
  createAgentToolset,
  decodeWireName,
  encodeWireName,
  encodeWireNameForInstance,
  MAX_WIRE_NAME_LENGTH,
  type AgentToolset,
} from "@agent-surface/core";
import { devicesTableDefinition, disableBinding, makeDevicesState } from "../helpers.js";

/** `billing.invoices.table.filters.set` — what a 300-capability app looks like. */
const DEEP_TYPE = "billing.invoices.table.filters";
const DEEP_ID = `view:${DEEP_TYPE}.setSelectedRange`;

function deepToolset(instanceIds: string[]): AgentToolset {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  for (const instanceId of instanceIds) {
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: DEEP_TYPE, instanceId }),
    );
  }
  return createAgentToolset(registry, {
    consumer: { id: "copilot", kind: "embedded" },
    topology: "embedded",
  });
}

describe("AS-WIRE-004 — no emitted name exceeds the provider budget", () => {
  it("shortens deep hierarchies, with and without an instance suffix", () => {
    const plain = encodeWireName(DEEP_ID);
    const perInstance = encodeWireNameForInstance(DEEP_ID, "comparison");
    expect(plain.length).toBeLessThanOrEqual(MAX_WIRE_NAME_LENGTH);
    expect(perInstance.length).toBeLessThanOrEqual(MAX_WIRE_NAME_LENGTH);
    // The natural encoding of the instance variant is over budget; that is
    // exactly the case that used to reach a provider unshortened.
    expect(`${DEEP_ID.replace(":", "_").replaceAll(".", "__")}_at_comparison`.length)
      .toBeGreaterThan(MAX_WIRE_NAME_LENGTH);
  });

  it("holds for every tool a real multi-instance catalog emits", () => {
    for (const tool of deepToolset(["main", "comparison"]).tools()) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(MAX_WIRE_NAME_LENGTH);
      expect(/^[a-zA-Z0-9_-]+$/.test(tool.name), tool.name).toBe(true);
    }
  });

  it("holds at every collision-escalation level", () => {
    for (let level = 0; level <= 4; level++) {
      const name = encodeWireNameForInstance(DEEP_ID, "comparison", level);
      expect(name.length, `level ${level}`).toBeLessThanOrEqual(MAX_WIRE_NAME_LENGTH);
    }
  });
});

describe("AS-WIRE-005 — names are deterministic across snapshots", () => {
  it("re-encoding the same id yields the same name", () => {
    expect(encodeWireName(DEEP_ID)).toBe(encodeWireName(DEEP_ID));
    expect(encodeWireNameForInstance(DEEP_ID, "main")).toBe(
      encodeWireNameForInstance(DEEP_ID, "main"),
    );
    // Distinct inputs stay distinct through the hash.
    expect(encodeWireNameForInstance(DEEP_ID, "main")).not.toBe(
      encodeWireNameForInstance(DEEP_ID, "comparison"),
    );
  });

  it("two registries with the same catalog emit the same names", () => {
    const a = deepToolset(["main", "comparison"]).tools().map((t) => t.name);
    const b = deepToolset(["main", "comparison"]).tools().map((t) => t.name);
    expect(a).toEqual(b);
  });

  it("assignment does not depend on the order entries are supplied in", () => {
    const entries = [
      { id: DEEP_ID, instanceId: "main" },
      { id: DEEP_ID, instanceId: "comparison" },
      { id: "view:devices.table.readState" },
    ];
    const forward = assignWireNames(entries);
    const reversed = assignWireNames([...entries].reverse());
    expect([...forward.byName.keys()].sort()).toEqual([...reversed.byName.keys()].sort());
  });
});

describe("AS-WIRE-006 — no collisions within one emitted catalog", () => {
  /**
   * A real level-0 collision, found by search over the shipped hash: same
   * 54-char kept prefix AND same 7-char hash. Escalation is the only thing that
   * separates these two, so this pins the path rather than the happy case.
   */
  const COLLIDING = [
    "view:aaaaaaaaaa.bbbbbbbbbb.cccccccccc.dddddddddd.eeeeeeeeee.cap8596",
    "view:aaaaaaaaaa.bbbbbbbbbb.cccccccccc.dddddddddd.eeeeeeeeee.cap2709660",
  ];

  it("the collision is real: the two ids encode to the same name on their own", () => {
    expect(encodeWireName(COLLIDING[0]!)).toBe(encodeWireName(COLLIDING[1]!));
  });

  it("escalates the hash so the emitted catalog stays unique", () => {
    const entries = COLLIDING.map((id) => ({ id }));
    const { names, byName } = assignWireNames(entries);
    expect(new Set(names).size).toBe(entries.length);
    expect(byName.size).toBe(entries.length);
    expect(byName.get(names[0]!)).toBe(COLLIDING[0]);
    expect(byName.get(names[1]!)).toBe(COLLIDING[1]);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(MAX_WIRE_NAME_LENGTH);
  });

  it("escalation is order-independent and leaves bystanders alone", () => {
    const bystander = { id: "view:devices.table.readState" };
    const forward = assignWireNames([{ id: COLLIDING[0]! }, { id: COLLIDING[1]! }, bystander]);
    const reversed = assignWireNames([bystander, { id: COLLIDING[1]! }, { id: COLLIDING[0]! }]);
    expect([...forward.byName].sort()).toEqual([...reversed.byName].sort());
    expect(forward.names[2]).toBe("view_devices__table__readState");
  });

  it("a catalog of near-identical deep ids stays unique", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      id: `view:${"deepsegment.".repeat(5)}capability${i}`,
    }));
    const { names } = assignWireNames(entries);
    expect(new Set(names).size).toBe(entries.length);
  });

  it("a real multi-instance catalog emits unique names", () => {
    const names = deepToolset(["main", "comparison", "third"]).tools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("AS-WIRE-007 — wireNameMap() round-trips every emitted name", () => {
  it("maps every tool name back to its canonical id", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.setProcedureExecutor({ paths: ["devices.disable"], execute: async () => ({}) });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state, { procedures: [disableBinding(state)] }));
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: DEEP_TYPE, instanceId: "main" }),
    );
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: DEEP_TYPE, instanceId: "comparison" }),
    );
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });

    const map = toolset.wireNameMap();
    for (const tool of toolset.tools()) {
      expect(map.get(tool.name), tool.name).toMatch(/^(view|domain):/);
    }
    expect(map.size).toBe(toolset.tools().length);
    expect(map.get("domain_devices__disable")).toBe("domain:devices.disable");
  });

  it("shortened and per-instance names decode to undefined, never to a wrong id", () => {
    const toolset = deepToolset(["main", "comparison"]);
    const map = toolset.wireNameMap();
    const shortened = toolset
      .tools()
      .map((t) => t.name)
      .filter((name) => decodeWireName(name) === undefined);

    // These exist — that is the whole reason the map is authoritative.
    expect(shortened.length).toBeGreaterThan(0);
    for (const name of shortened) {
      expect(map.get(name)).toBeDefined();
      expect(map.get(name)).not.toBe(name); // no degrading id → wire name
    }
  });

  it("string surgery on an instance-suffixed name is refused outright", () => {
    // 0.1 answered "view:devices.table.readState_at_main" here: a plausible id
    // that is not the capability's, which is how audit identity gets lost.
    const name = encodeWireNameForInstance("view:devices.table.readState", "main");
    expect(name).toBe("view_devices__table__readState_at_main");
    expect(decodeWireName(name)).toBeUndefined();
  });

  it("faithfully encoded names still decode without the map", () => {
    expect(decodeWireName("view_devices__table__selectRows")).toBe(
      "view:devices.table.selectRows",
    );
    expect(decodeWireName("domain_devices__disable")).toBe("domain:devices.disable");
  });

  it("the map is refreshed with the catalog it belongs to", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const toolset = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
    });
    expect(toolset.wireNameMap().size).toBe(0);

    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    expect(toolset.wireNameMap().get("view_devices__table__readState")).toBe(
      "view:devices.table.readState",
    );

    handle.unregister();
    expect(toolset.wireNameMap().size).toBe(0);
  });

  it("meta mode has no capability names to map", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const meta = createAgentToolset(registry, {
      consumer: { id: "copilot", kind: "embedded" },
      topology: "embedded",
      mode: "meta",
    });
    expect(meta.wireNameMap().size).toBe(0);
  });
});
