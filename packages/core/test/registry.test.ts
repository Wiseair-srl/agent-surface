import { describe, expect, it, vi } from "vitest";
import {
  createAgentSurfaceRegistry,
  type AgentSurfaceEvent,
} from "@agent-surface/core";
import { devicesTableDefinition, makeDevicesState } from "./helpers.js";

const flushMicrotasks = (): Promise<void> => Promise.resolve().then(() => {});

describe("registration lifecycle (docs/03)", () => {
  it("register → live in next snapshot; unregister → gone", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    expect(handle.status).toBe("active");
    expect(registry.snapshot().components).toHaveLength(1);
    handle.unregister();
    expect(handle.status).toBe("unregistered");
    expect(registry.snapshot().components).toHaveLength(0);
  });

  it("Strict-Mode-like double register/unregister is symmetric", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const events: AgentSurfaceEvent[] = [];
    registry.subscribe((e) => events.push(e));

    const state = makeDevicesState();
    const h1 = registry.register(devicesTableDefinition(state));
    h1.unregister();
    const h2 = registry.register(devicesTableDefinition(state));
    await flushMicrotasks();

    expect(h1.registrationId).not.toBe(h2.registrationId);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "component-registered",
      "component-unregistered",
      "component-registered",
      "surface-changed", // coalesced within the microtask
    ]);
    expect(registry.snapshot().components).toHaveLength(1);
  });

  it("post-unregister handle calls are no-ops", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    handle.unregister();
    const version = registry.getVersion();
    handle.update({ enabled: false });
    handle.invalidate();
    handle.unregister();
    expect(registry.getVersion()).toBe(version);
  });
});

describe("collisions (D4)", () => {
  it('duplicate (type, instanceId) under "reject": dead handle, first wins', () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const events: AgentSurfaceEvent[] = [];
    registry.subscribe((e) => events.push(e));
    const h1 = registry.register(devicesTableDefinition(makeDevicesState()));
    const h2 = registry.register(devicesTableDefinition(makeDevicesState()));
    expect(h1.status).toBe("active");
    expect(h2.status).toBe("rejected");
    expect(registry.snapshot().components).toHaveLength(1);
    expect(registry.snapshot().components[0]?.registrationId).toBe(h1.registrationId);
    expect(
      events.some((e) => e.type === "component-rejected" && e.reason === "duplicate"),
    ).toBe(true);
  });

  it('duplicate under "replace": previous unregistered, newcomer wins', () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      onDuplicateInstance: "replace",
    });
    const h1 = registry.register(devicesTableDefinition(makeDevicesState()));
    const h2 = registry.register(devicesTableDefinition(makeDevicesState()));
    expect(h1.status).toBe("unregistered");
    expect(h2.status).toBe("active");
    expect(registry.snapshot().components[0]?.registrationId).toBe(h2.registrationId);
  });

  it("guard rejection produces a dead handle + component-rejected(guard)", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      onRegister: (candidate) =>
        candidate.definition.origin === "third-party" ? "reject" : "accept",
    });
    const events: AgentSurfaceEvent[] = [];
    registry.subscribe((e) => events.push(e));
    const ok = registry.register(devicesTableDefinition(makeDevicesState()));
    const rejected = registry.register(
      devicesTableDefinition(makeDevicesState(), {
        instanceId: "other",
        origin: "third-party",
      }),
    );
    expect(ok.status).toBe("active");
    expect(rejected.status).toBe("rejected");
    expect(events.some((e) => e.type === "component-rejected" && e.reason === "guard")).toBe(true);
  });

  it("distinct instanceIds coexist", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "main" }));
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "comparison" }));
    expect(registry.snapshot().components).toHaveLength(2);
  });
});

describe("versioning matrix (D1)", () => {
  it("register/unregister/update/invalidate bump; no-op update does not", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const v = (): number => Number(registry.getVersion());
    expect(v()).toBe(0);

    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    expect(v()).toBe(1);

    handle.update({ enabled: false });
    expect(v()).toBe(2);
    handle.update({ enabled: false }); // unchanged ⇒ no bump
    expect(v()).toBe(2);

    handle.update({ availability: { selectRows: { available: false, reason: "no rows" } } });
    expect(v()).toBe(3);
    handle.update({ availability: { selectRows: { available: false, reason: "no rows" } } });
    expect(v()).toBe(3);

    handle.invalidate();
    expect(v()).toBe(4);

    handle.unregister();
    expect(v()).toBe(5);
  });

  it("lazy when() drift does NOT bump the version", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const state = makeDevicesState();
    registry.register(devicesTableDefinition(state));
    const before = registry.getVersion();
    state.selectedIds = ["d1"]; // clearSelection's when() flips true, lazily
    expect(registry.getVersion()).toBe(before);
    // …but the snapshot reflects the fresh evaluation (docs/03 §availability).
    const cap = registry
      .snapshot()
      .components[0]!.actions.find((a) => a.name === "clearSelection");
    expect(cap?.available).toBe(true);
  });

  it("surfaceIds differ per registry; versions are decimal strings", () => {
    const a = createAgentSurfaceRegistry({ environment: "test" });
    const b = createAgentSurfaceRegistry({ environment: "test" });
    expect(a.surfaceId).not.toBe(b.surfaceId);
    expect(a.surfaceId.startsWith("srf_")).toBe(true);
    expect(a.getVersion()).toBe("0");
  });
});

describe("event ordering guarantees (D17)", () => {
  it("events dispatch in mutation order, after the mutation completes", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const seen: string[] = [];
    registry.subscribe((e) => {
      if (e.type === "component-registered") {
        // The mutation completed before dispatch: the snapshot already has it.
        seen.push(`${e.type}:${registry.snapshot().components.length}`);
      }
    });
    registry.register(devicesTableDefinition(makeDevicesState()));
    expect(seen).toEqual(["component-registered:1"]);
  });

  it("listener exceptions are isolated and never skip other listeners", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const seen: string[] = [];
    registry.subscribe(() => {
      throw new Error("listener boom");
    });
    registry.subscribe((e) => seen.push(e.type));
    registry.register(devicesTableDefinition(makeDevicesState()));
    expect(seen).toContain("component-registered");
    expect(registry.snapshot().components).toHaveLength(1); // state not corrupted
  });

  it("registry mutations from listeners are queued, not re-entrant", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const order: string[] = [];
    let nested = false;
    registry.subscribe((e) => {
      if (e.type !== "component-registered") return;
      order.push(`start:${e.componentType}:${e.instanceId}`);
      if (!nested) {
        nested = true;
        registry.register(
          devicesTableDefinition(makeDevicesState(), { instanceId: "nested" }),
        );
      }
      order.push(`end:${e.componentType}:${e.instanceId}`);
    });
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "outer" }));
    // The nested registration's event is delivered AFTER the outer dispatch
    // completes — no interleaving inside a single listener invocation.
    expect(order).toEqual([
      "start:devices.table:outer",
      "end:devices.table:outer",
      "start:devices.table:nested",
      "end:devices.table:nested",
    ]);
  });

  it("surface-changed coalesces mutations within one microtask, carrying the latest version", async () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const surfaceChanged: string[] = [];
    registry.subscribe((e) => {
      if (e.type === "surface-changed") surfaceChanged.push(e.surfaceVersion);
    });
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "a" }));
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "b" }));
    registry.register(devicesTableDefinition(makeDevicesState(), { instanceId: "c" }));
    await flushMicrotasks();
    expect(surfaceChanged).toEqual([registry.getVersion()]);
    expect(registry.getVersion()).toBe("3");
  });

  it("availability-changed fires per pushed capability change", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    const handle = registry.register(devicesTableDefinition(makeDevicesState()));
    const events: AgentSurfaceEvent[] = [];
    registry.subscribe((e) => events.push(e));
    handle.update({ availability: { selectRows: { available: false, reason: "busy" } } });
    expect(events).toContainEqual({
      type: "availability-changed",
      registrationId: handle.registrationId,
      capabilityId: "view:devices.table.selectRows",
      available: false,
    });
  });
});

describe("dispose", () => {
  it("settles in-flight as CANCELLED, clears listeners, rejects further use", async () => {
    vi.useFakeTimers();
    try {
      const registry = createAgentSurfaceRegistry({ environment: "test" });
      const state = makeDevicesState();
      const def = devicesTableDefinition(state);
      def.actions!.hang = {
        description: "hangs forever",
        input: def.actions!.selectRows!.input,
        effect: "local-state",
        execute: () => new Promise(() => {}),
      };
      registry.register(def);
      const pending = registry.invoke({
        capabilityId: "view:devices.table.hang",
        input: { ids: ["d1"] },
      });
      registry.dispose();
      const result = await pending;
      expect(result.status).toBe("error");
      expect(result.status === "error" && result.error.code).toBe("CANCELLED");
      expect(() => registry.snapshot()).toThrow();
      expect(() => registry.register(devicesTableDefinition(makeDevicesState()))).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
