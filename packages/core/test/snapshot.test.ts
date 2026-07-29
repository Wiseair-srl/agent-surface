// Conformance: AS-SNAP-001 (pure sync snapshot D5), AS-SNAP-002 (internal never serialized D9), AS-SNAP-003 (deterministic ordering + budget marker D6)
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  observation,
} from "@agent-surface/core";
import { devicesTableDefinition, makeDevicesState } from "./helpers.js";

describe("snapshot (docs/03 §snapshot, D5)", () => {
  it("is synchronous and never runs read() handlers", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const readSpy = vi.fn(() => ({ value: 1 }));
    registry.register(
      defineAgentComponent({
        type: "widget.spy",
        description: "spy",
        observations: {
          state: observation({
            description: "spied state",
            output: fromJsonSchema({ type: "object", additionalProperties: true }),
            read: readSpy,
          }),
        },
      }),
    );
    const snapshot = registry.snapshot();
    expect(readSpy).not.toHaveBeenCalled();
    expect(snapshot.components[0]?.observations[0]?.capabilityId).toBe("view:widget.spy.state");
  });

  it("never serializes `internal` metadata (deep scan)", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      devicesTableDefinition(makeDevicesState(), {
        meta: { visible: "yes" },
        internal: { secretToken: "s3cr3t", tenant: "acme" },
      }),
    );
    const serialized = JSON.stringify(registry.snapshot());
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("internal");
    expect(serialized).toContain("visible");
  });

  it("descriptors are deep-frozen", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.components[0])).toBe(true);
    expect(Object.isFrozen(snapshot.components[0]?.actions[0])).toBe(true);
    expect(() => {
      (snapshot.components as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("ordering is (priority desc, type, instanceId) — never mount order", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: "zebra.panel", instanceId: "z" }),
    );
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: "alpha.panel", instanceId: "b" }),
    );
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: "alpha.panel", instanceId: "a" }),
    );
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: "low.panel", priority: 5 }),
    );
    const order = registry.snapshot().components.map((c) => `${c.type}:${c.instanceId}`);
    expect(order).toEqual([
      "low.panel:default",
      "alpha.panel:a",
      "alpha.panel:b",
      "zebra.panel:z",
    ]);
  });

  it("scope filters by component-type prefix", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    registry.register(
      devicesTableDefinition(makeDevicesState(), { type: "reports.panel" }),
    );
    const scoped = registry.snapshot({ scope: ["devices"] });
    expect(scoped.components.map((c) => c.type)).toEqual(["devices.table"]);
    // A prefix must match whole segments, not substrings.
    expect(registry.snapshot({ scope: ["dev"] }).components).toHaveLength(0);
  });

  it("includeUnavailable: false filters visible-disabled capabilities", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState())); // empty selection ⇒ clearSelection disabled
    const withUnavailable = registry.snapshot();
    const withoutUnavailable = registry.snapshot({ includeUnavailable: false });
    const names = (s: typeof withUnavailable): string[] =>
      s.components[0]!.actions.map((a) => a.name);
    expect(names(withUnavailable)).toContain("clearSelection");
    expect(names(withoutUnavailable)).not.toContain("clearSelection");
  });

  it("visible-disabled capabilities carry unavailableReason (D11)", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const cap = registry
      .snapshot()
      .components[0]!.actions.find((a) => a.name === "clearSelection");
    expect(cap?.available).toBe(false);
    expect(cap?.unavailableReason).toBe("No rows are selected");
  });

  it("enabled: false ⇒ all capabilities visible-disabled with component-disabled", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    handle.update({ enabled: false });
    const component = registry.snapshot().components[0]!;
    for (const cap of [...component.observations, ...component.actions]) {
      expect(cap.available).toBe(false);
      expect(cap.unavailableReason).toBe("component-disabled");
    }
  });

  it("budget drops lowest-priority components first and says so (Experimental)", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "high.panel", priority: 10 }));
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "mid.panel", priority: 5 }));
    registry.register(devicesTableDefinition(makeDevicesState(), { type: "low.panel", priority: 0 }));
    const snapshot = registry.snapshot({ budget: { maxComponents: 2 } });
    expect(snapshot.components.map((c) => c.type)).toEqual(["high.panel", "mid.panel"]);
    expect(snapshot.truncated).toEqual({ droppedComponents: 1 });
  });

  it("includes route info from the host wiring", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      route: () => ({ path: "/devices" }),
    });
    expect(registry.snapshot().route).toEqual({ path: "/devices" });
  });
});
