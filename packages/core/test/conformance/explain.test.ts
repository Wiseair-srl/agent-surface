// Conformance: AS-EXPLAIN-001 (hidden capabilities are explained, not omitted),
// AS-EXPLAIN-002 (per-policy votes attributed by name and chain scope),
// AS-EXPLAIN-003 (composed outcome always agrees with the snapshot),
// AS-EXPLAIN-004 (never reachable from the agent-facing package root).
import { describe, expect, it } from "vitest";
import * as packageRoot from "@agent-surface/core";
import {
  authenticated,
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  observation,
  requireConfirmation,
  type AgentPolicy,
} from "@agent-surface/core";
import { explainSurface } from "@agent-surface/core/explain";
import { devicesTableDefinition, makeDevicesState } from "../helpers.js";

const trivialObservation = observation({
  description: "a value",
  output: fromJsonSchema<{ value: number }>({
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
  }),
  read: () => ({ value: 1 }),
});

function namedPolicy(name: string, decision?: AgentPolicy["onDiscovery"]): AgentPolicy {
  return decision ? { name, onDiscovery: decision } : { name };
}

describe("explainSurface — hidden capabilities (AS-EXPLAIN-001)", () => {
  it("explains what the snapshot deletes: a policy-hidden capability, and which policy hid it", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      context: () => ({ user: null }), // authenticated() hides
      policies: [authenticated()],
    });
    registry.register(devicesTableDefinition(makeDevicesState()));

    // The agent-facing view: the component does not exist at all.
    const snapshot = registry.snapshot();
    expect(snapshot.components).toHaveLength(0);

    // The developer view: it exists, it is hidden, and `authenticated` did it.
    const explanation = explainSurface(registry);
    expect(explanation.capabilities.length).toBeGreaterThan(0);
    const readState = explanation.capabilities.find(
      (c) => c.capabilityId === "view:devices.table.readState",
    );
    expect(readState?.outcome).toBe("hide");
    expect(readState?.policies.map((p) => p.name)).toContain("authenticated");
    expect(readState?.policies.find((p) => p.name === "authenticated")?.discovery).toEqual({
      decision: "hide",
    });
    registry.dispose();
  });

  it("separates authority from state: a `when()` denial is availability, not policy", () => {
    const state = makeDevicesState();
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(
      defineAgentComponent({
        type: "devices.drawer",
        description: "Drawer",
        observations: { state: trivialObservation },
        actions: {
          close: {
            description: "Close the drawer",
            input: fromJsonSchema<Record<string, never>>({ type: "object" }),
            effect: "local-state",
            when: () => state.selectedIds.length > 0,
            unavailableReason: "The drawer is not open",
            execute: () => ({}),
          },
        },
      }),
    );

    const close = explainSurface(registry).capabilities.find(
      (c) => c.capabilityId === "view:devices.drawer.close",
    );
    expect(close?.outcome).toBe("disable");
    expect(close?.availability).toEqual({ available: false, reason: "The drawer is not open" });
    // No policy voted it down — the UI state did.
    expect(close?.policies.filter((p) => p.discovery?.decision !== "expose")).toHaveLength(0);
    registry.dispose();
  });

  it("records a throwing onDiscovery, which the snapshot silently fails closed on", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      policies: [
        namedPolicy("exploding", () => {
          throw new Error("boom");
        }),
      ],
    });
    registry.register(devicesTableDefinition(makeDevicesState()));

    expect(registry.snapshot().components).toHaveLength(0); // fails closed, no trace
    const cap = explainSurface(registry).capabilities[0];
    expect(cap?.outcome).toBe("hide");
    const exploding = cap?.policies.find((p) => p.name === "exploding");
    expect(exploding?.threw).toBe(true);
    expect(exploding?.discovery).toEqual({ decision: "hide" });
    registry.dispose();
  });
});

describe("explainSurface — chain attribution (AS-EXPLAIN-002)", () => {
  it("names every policy and the layer it came from, registry-outermost first", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      policies: [namedPolicy("from-registry", () => ({ decision: "expose" }))],
    });
    registry.register(
      defineAgentComponent({
        type: "widget.panel",
        description: "panel",
        policies: [namedPolicy("from-component", () => ({ decision: "expose" }))],
        observations: {
          state: observation({
            description: "a value",
            output: fromJsonSchema<{ value: number }>({
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            }),
            read: () => ({ value: 1 }),
            policies: [namedPolicy("from-capability", () => ({ decision: "expose" }))],
          }),
        },
      }),
    );

    const cap = explainSurface(registry).capabilities[0];
    expect(cap?.policies.map((p) => [p.name, p.scope])).toEqual([
      ["from-registry", "registry"],
      ["from-component", "component"],
      ["from-capability", "capability"],
    ]);
    registry.dispose();
  });

  it("reports which pipeline phases a policy implements, and confirmation escalation", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      context: () => ({ user: { id: "u1" } }),
      policies: [authenticated(), requireConfirmation()],
    });
    registry.register(devicesTableDefinition(makeDevicesState()));

    const cap = explainSurface(registry).capabilities[0];
    const auth = cap?.policies.find((p) => p.name === "authenticated");
    const confirm = cap?.policies.find((p) => p.name === "require-confirmation");
    expect(auth?.phases).toEqual(["discovery", "authorize"]);
    expect(confirm?.phases).toEqual([]);
    expect(confirm?.confirmationEscalation).toBe(true);
    expect(auth?.confirmationEscalation).toBeUndefined();
    registry.dispose();
  });

  it("keeps the first disable reason, matching evaluateDiscovery's most-restrictive-wins", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      policies: [
        namedPolicy("first", () => ({ decision: "disable", reason: "first reason" })),
        namedPolicy("second", () => ({ decision: "disable", reason: "second reason" })),
      ],
    });
    registry.register(devicesTableDefinition(makeDevicesState()));

    const cap = explainSurface(registry).capabilities[0];
    expect(cap?.outcome).toBe("disable");
    expect(cap?.reason).toBe("first reason");
    // Both votes survive in the attribution, even though only one shapes the outcome.
    expect(cap?.policies.map((p) => p.discovery?.decision)).toEqual(["disable", "disable"]);
    registry.dispose();
  });
});

describe("explainSurface — agreement with the snapshot (AS-EXPLAIN-003)", () => {
  const cases: Array<{ name: string; policies: AgentPolicy[]; user: unknown }> = [
    { name: "no policies", policies: [], user: { id: "u1" } },
    { name: "authenticated, signed in", policies: [authenticated()], user: { id: "u1" } },
    { name: "authenticated, signed out", policies: [authenticated()], user: null },
    {
      name: "disable then hide",
      policies: [
        namedPolicy("d", () => ({ decision: "disable", reason: "nope" })),
        namedPolicy("h", () => ({ decision: "hide" })),
      ],
      user: { id: "u1" },
    },
    {
      name: "hide then disable (order must not matter)",
      policies: [
        namedPolicy("h", () => ({ decision: "hide" })),
        namedPolicy("d", () => ({ decision: "disable", reason: "nope" })),
      ],
      user: { id: "u1" },
    },
    {
      name: "disable only",
      policies: [namedPolicy("d", () => ({ decision: "disable", reason: "held" }))],
      user: { id: "u1" },
    },
  ];

  for (const testCase of cases) {
    it(`agrees with snapshot(): ${testCase.name}`, () => {
      const registry = createAgentSurfaceRegistry({
        environment: "test",
        context: () => ({ user: testCase.user }),
        policies: testCase.policies,
      });
      registry.register(devicesTableDefinition(makeDevicesState()));

      const snapshot = registry.snapshot({ includeUnavailable: true });
      const inSnapshot = new Map(
        snapshot.components.flatMap((component) =>
          [...component.observations, ...component.actions].map((cap) => [
            cap.capabilityId,
            cap,
          ]),
        ),
      );

      for (const explained of explainSurface(registry).capabilities) {
        const shown = inSnapshot.get(explained.capabilityId);
        if (explained.outcome === "hide") {
          expect(shown, `${explained.capabilityId} explained hide`).toBeUndefined();
          continue;
        }
        expect(shown, `${explained.capabilityId} explained ${explained.outcome}`).toBeDefined();
        expect(shown?.available).toBe(explained.outcome === "expose");
        expect(shown?.unavailableReason).toBe(explained.reason);
      }
      // …and nothing the snapshot shows is missing from the explanation.
      const explainedIds = new Set(
        explainSurface(registry).capabilities.map((c) => c.capabilityId),
      );
      for (const id of inSnapshot.keys()) expect(explainedIds.has(id)).toBe(true);
      registry.dispose();
    });
  }

  it("honours scope and consumer so it lines up with the snapshot being debugged", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    registry.register(
      defineAgentComponent({
        type: "billing.panel",
        description: "billing",
        observations: { state: trivialObservation },
      }),
    );

    const scoped = explainSurface(registry, { scope: ["devices"] });
    expect(scoped.capabilities.every((c) => c.component.type.startsWith("devices"))).toBe(true);
    expect(scoped.consumer).toEqual({ id: "anonymous", kind: "embedded" });

    const asOperator = explainSurface(registry, {
      consumer: { id: "op", kind: "embedded" },
    });
    expect(asOperator.consumer).toEqual({ id: "op", kind: "embedded" });
    registry.dispose();
  });

  it("refuses a foreign or disposed registry rather than guessing", () => {
    expect(() => explainSurface({} as never)).toThrow(/createAgentSurfaceRegistry/);
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.dispose();
    expect(() => explainSurface(registry)).toThrow(/disposed/);
  });
});

describe("explainSurface — disclosure boundary (AS-EXPLAIN-004)", () => {
  it("is absent from the package root that adapters import", () => {
    expect("explainSurface" in packageRoot).toBe(false);
    expect(
      Object.keys(packageRoot).filter((key) => key.toLowerCase().includes("explain")),
    ).toEqual([]);
  });

  it("is deep-frozen, like the snapshot", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test" });
    registry.register(devicesTableDefinition(makeDevicesState()));
    const explanation = explainSurface(registry);
    expect(Object.isFrozen(explanation)).toBe(true);
    expect(Object.isFrozen(explanation.capabilities[0])).toBe(true);
    registry.dispose();
  });
});
