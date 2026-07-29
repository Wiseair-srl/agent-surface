import { StrictMode, useState } from "react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { action, fromJsonSchema, observation } from "@agent-surface/core";
import { useAgentComponent, usePendingConfirmations } from "@agent-surface/react";
import { renderAgentSurface } from "@agent-surface/testing/react";
import { matchers } from "@agent-surface/testing/matchers";
import { DevicesTable } from "./fixtures.js";

expect.extend(matchers);

const anyObject = fromJsonSchema({ type: "object", additionalProperties: true });

describe("useAgentComponent lifecycle (docs/04)", () => {
  it("registers on mount, exposes the documented surface, unregisters on unmount", async () => {
    const surface = await renderAgentSurface(<DevicesTable />);
    expect(surface).toExpose("view:devices.table.readState");
    expect(surface).toExpose("view:devices.table.selectRows");
    expect(surface).toExposeUnavailable("view:devices.table.clearSelection", {
      reason: "No rows are selected",
    });

    surface.unmount();
    const result = await surface.invoke("view:devices.table.selectRows", { ids: ["d1"] });
    expect(result).toFailWith("COMPONENT_UNMOUNTED");
    surface.dispose();
  });

  it("invocation + observation round-trip through real React state", async () => {
    const surface = await renderAgentSurface(<DevicesTable />);
    const invoked = await surface.invoke("view:devices.table.selectRows", {
      ids: ["d1"],
      mode: "replace",
    });
    expect(invoked).toBeOk();
    await act(async () => {}); // let React commit the state update
    const state = await surface.observe<{ selectedIds: string[] }>(
      "view:devices.table.readState",
    );
    expect(state.selectedIds).toEqual(["d1"]);
    expect(surface.view.getByTestId("devices-table").textContent).toBe("d1");
    surface.dispose();
  });

  it("Strict Mode: register → unregister → register symmetry, surface stays clean", async () => {
    const surface = await renderAgentSurface(
      <StrictMode>
        <DevicesTable />
      </StrictMode>,
    );
    const registered = surface.events().filter((e) => e.type === "component-registered");
    const unregistered = surface.events().filter((e) => e.type === "component-unregistered");
    expect(registered.length).toBe(unregistered.length + 1); // net one live registration
    expect(surface.snapshot().components).toHaveLength(1);

    const result = await surface.invoke("view:devices.table.selectRows", { ids: ["d1"] });
    expect(result).toBeOk();
    surface.dispose();
  });

  it("staleness: a captured registrationId fails after a keyed remount", async () => {
    const surface = await renderAgentSurface(<DevicesTable key="a" />);
    const ref = surface.captureRef("view:devices.table.selectRows");
    surface.rerender(<DevicesTable key="b" />); // new registration
    const result = await surface.invoke(
      "view:devices.table.selectRows",
      { ids: ["d1"] },
      { registrationId: ref.registrationId },
    );
    expect(result).toFailWith("STALE_CAPABILITY", { reason: "registration-replaced" });
    surface.dispose();
  });

  it("handler freshness (D3): handlers see current state without re-registration", async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      useAgentComponent({
        type: "widget.counter",
        description: "Counter",
        observations: {
          value: observation({
            description: "Current count",
            output: anyObject,
            read: () => ({ count }),
          }),
        },
        actions: {
          increment: action({
            description: "Add one",
            input: anyObject,
            effect: "local-state",
            execute: () => setCount((c) => c + 1),
          }),
        },
      });
      return null;
    }
    const surface = await renderAgentSurface(<Counter />);
    const registrationId = surface.snapshot().components[0]!.registrationId;
    for (let i = 0; i < 3; i++) {
      await surface.invoke("view:widget.counter.increment", {});
      await act(async () => {});
    }
    // No re-registration despite three re-renders with fresh closures.
    expect(surface.snapshot().components[0]!.registrationId).toBe(registrationId);
    const state = await surface.observe<{ count: number }>("view:widget.counter.value");
    expect(state.count).toBe(3);
    surface.dispose();
  });

  it("availability is pushed on when() flips: version bumps and events fire", async () => {
    const surface = await renderAgentSurface(<DevicesTable />);
    const before = surface.registry.getVersion();
    await surface.invoke("view:devices.table.selectRows", { ids: ["d1"] });
    await act(async () => {});
    expect(surface).toExpose("view:devices.table.clearSelection");
    expect(surface.registry.getVersion()).not.toBe(before);
    expect(
      surface
        .events()
        .some(
          (e) =>
            e.type === "availability-changed" &&
            e.capabilityId === "view:devices.table.clearSelection" &&
            e.available === true,
        ),
    ).toBe(true);
    surface.dispose();
  });

  it("enabled: false ⇒ visible-disabled (mounted but not presented)", async () => {
    function Tab(props: { active: boolean }) {
      useAgentComponent({
        type: "widget.tab",
        description: "Tab content",
        enabled: props.active,
        actions: {
          poke: action({
            description: "Poke",
            input: anyObject,
            effect: "local-state",
            execute: () => {},
          }),
        },
      });
      return null;
    }
    const surface = await renderAgentSurface(<Tab active={false} />);
    expect(surface).toExposeUnavailable("view:widget.tab.poke", { reason: "component-disabled" });
    surface.rerender(<Tab active={true} />);
    expect(surface).toExpose("view:widget.tab.poke");
    surface.dispose();
  });

  it("identity change (instanceId) re-registers with a new registrationId", async () => {
    const surface = await renderAgentSurface(<DevicesTable instance="main" />);
    const first = surface.snapshot().components[0]!.registrationId;
    surface.rerender(<DevicesTable instance="comparison" />);
    const component = surface.snapshot().components[0]!;
    expect(component.instanceId).toBe("comparison");
    expect(component.registrationId).not.toBe(first);
    surface.dispose();
  });

  it("two instances coexist; targeting requires instanceId (AMBIGUOUS otherwise)", async () => {
    const surface = await renderAgentSurface(
      <>
        <DevicesTable instance="main" />
        <DevicesTable instance="comparison" />
      </>,
    );
    expect(surface.snapshot().components).toHaveLength(2);
    const ambiguous = await surface.invoke("view:devices.table.selectRows", { ids: ["d1"] });
    expect(ambiguous).toFailWith("AMBIGUOUS_INSTANCE");
    const targeted = await surface.invoke(
      "view:devices.table.selectRows",
      { ids: ["d1"] },
      { instanceId: "main" },
    );
    expect(targeted).toBeOk();
    surface.dispose();
  });

  it("structural config change on a live registration logs and re-registers (D2)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Mutating(props: { description: string }) {
      useAgentComponent({
        type: "widget.mutating",
        description: props.description,
        actions: {
          poke: action({
            description: "Poke",
            input: anyObject,
            effect: "local-state",
            execute: () => {},
          }),
        },
      });
      return null;
    }
    const surface = await renderAgentSurface(<Mutating description="first" />);
    const first = surface.snapshot().components[0]!.registrationId;
    surface.rerender(<Mutating description="second (a structural change!)" />);
    await act(async () => {});
    const component = surface.snapshot().components[0]!;
    expect(component.registrationId).not.toBe(first);
    expect(component.description).toContain("second");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    surface.dispose();
  });

  it("unmount mid-invoke through real React settles COMPONENT_UNMOUNTED", async () => {
    function Hanging() {
      useAgentComponent({
        type: "widget.hanging",
        description: "hangs",
        actions: {
          hang: action({
            description: "never resolves",
            input: anyObject,
            effect: "local-state",
            execute: () => new Promise<void>(() => {}),
          }),
        },
      });
      return null;
    }
    const surface = await renderAgentSurface(<Hanging />);
    const pending = surface.invoke("view:widget.hanging.hang", {});
    await new Promise((r) => setTimeout(r, 0));
    surface.unmount();
    const result = await pending;
    expect(result).toFailWith("COMPONENT_UNMOUNTED", { phase: "mid-flight" });
    surface.dispose();
  });
});

describe("usePendingConfirmations (docs/04)", () => {
  it("renders pending confirmations reactively; approve resolves the evidence", async () => {
    function Guarded() {
      useAgentComponent({
        type: "widget.guarded",
        description: "guarded",
        actions: {
          wipe: action({
            description: "Wipe the draft",
            input: anyObject,
            effect: "local-state",
            reversible: false,
            confirmation: "required",
            execute: () => {},
          }),
        },
      });
      const pending = usePendingConfirmations();
      return (
        <div>
          {pending.map((p) => (
            <button key={p.confirmationId} data-testid="approve" onClick={() => p.approve()}>
              {p.summary}
            </button>
          ))}
        </div>
      );
    }
    const surface = await renderAgentSurface(<Guarded />);
    const first = await surface.invoke("view:widget.guarded.wipe", {});
    expect(first).toFailWith("CONFIRMATION_REQUIRED");
    await act(async () => {});
    const button = surface.view.getByTestId("approve");
    act(() => {
      button.click();
    });
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    const second = await surface.invoke("view:widget.guarded.wipe", {}, { confirmationId });
    expect(second).toBeOk();
    surface.dispose();
  });
});

describe("semantic surface snapshot as a PR artifact", () => {
  it("matches the committed surface snapshot", async () => {
    const surface = await renderAgentSurface(<DevicesTable />);
    expect(surface).toMatchSurfaceSnapshot();
    surface.dispose();
  });
});
