// Conformance: AS-EXAMPLE-001 (docs/10 scenario end-to-end, no LLM)
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentToolset } from "@agent-surface/core";
import { mountScenario } from "@agent-surface/cli/vitest";
import { matchers } from "@agent-surface/testing/matchers";
import { runDevicesScenario } from "../src/agent/scripted-agent.js";
import surfaceConfig from "../agent-surface.config.js";

expect.extend(matchers);

/**
 * The scenarios come from `agent-surface.config.tsx` — the same file
 * `agent-surface inspect` and `agent-surface check` read. This suite used to
 * build the app a second way, which meant "signed-in operator on /devices"
 * existed twice and could drift; now there is one definition and three
 * consumers of it.
 */
async function renderApp(scenario: "admin" | "anonymous" = "admin") {
  const { surface, app: wiring } = await mountScenario(surfaceConfig, scenario);
  return { wiring, surface };
}

describe("the devices page exposes exactly the documented surface (docs/10)", () => {
  it("exposes the target surface while mounted, and commits it as a snapshot", async () => {
    const { surface } = await renderApp();
    for (const id of [
      "view:devices.filters.read",
      "view:devices.filters.set",
      "view:devices.table.readState",
      "view:devices.table.selectRows",
      "view:devices.table.sort",
      "view:devices.drawer.state",
      "view:devices.drawer.open",
      "view:app.navigation.current",
      "view:app.navigation.goTo",
    ]) {
      expect(surface).toExpose(id);
    }
    // State discloses: closed drawer and empty selection are visible-disabled.
    expect(surface).toExposeUnavailable("view:devices.drawer.close", {
      reason: "The drawer is not open",
    });
    expect(surface).toExposeUnavailable("domain:devices.disable", {
      reason: "Select at least one device first",
    });
    // The reviewable "what agents can see" artifact (docs/08 CI posture).
    expect(surface).toMatchSurfaceSnapshot();
    surface.dispose();
  });

  it("authority hides: signed-out sessions see an empty surface", async () => {
    const { surface } = await renderApp("anonymous");
    expect(surface.snapshot().components).toHaveLength(0);
    expect(surface.snapshot().procedures).toHaveLength(0);
    expect(surface).not.toExpose("domain:devices.disable");
    const result = await surface.invoke("view:devices.filters.set", { status: "offline" });
    expect(result.status).toBe("error");
    surface.dispose();
  });
});

describe("the scripted agent completes the docs/10 scenario end to end (no LLM)", () => {
  it("filters → read → select → confirm → authoritative disable → verify", async () => {
    const { wiring, surface } = await renderApp();
    const toolset = createAgentToolset(wiring.registry, {
      consumer: { id: "copilot-panel", kind: "embedded" },
      confirmations: "wait",
    });

    // The scenario runs like a real embedded loop — outside act; the agent
    // waits for view settling itself. Keep a rejection handler attached so a
    // failing scenario surfaces as a test failure, never as a hang.
    const scenario = runDevicesScenario(toolset, { city: "Milano" });
    scenario.catch(() => {});

    // The destructive step parks on user confirmation (wait mode); the host
    // dialog shows the exact bound input, and the user approves it.
    await waitFor(
      () => {
        expect(wiring.registry.confirmations.pending()).toHaveLength(1);
        expect(surface.view.getByTestId("confirmation-summary").textContent).toContain(
          "Disable the given devices",
        );
      },
      { timeout: 3000 },
    );
    act(() => {
      surface.view.getByTestId("confirmation-approve").click();
    });
    const outcome = await scenario;
    await act(async () => {}); // let the app's query invalidation settle

    // The agent saw the three offline Milano devices and disabled them.
    expect(outcome.selectedIds).toEqual(["dev_1", "dev_2", "dev_3"]);
    expect(outcome.disabled).toBe(3);

    // The server executed authoritatively: state changed in the backend.
    for (const id of ["dev_1", "dev_2", "dev_3"]) {
      expect(wiring.backend.devices.find((d) => d.id === id)?.status).toBe("disabled");
    }

    // The executor forwarded the BOUND input plus evidence via callContext.
    const disableCall = wiring.backend.calls.find((c) => c.path === "devices.disable")!;
    expect(disableCall.input).toEqual({ deviceIds: ["dev_1", "dev_2", "dev_3"] });
    expect(disableCall.context).toMatchObject({
      agentInvocationId: expect.stringContaining("call_"),
      confirmation: { id: expect.stringContaining("cnf_") },
    });

    // Step 11 — the audit trail tells the whole story.
    const events = surface.events().map((e) => e.type);
    expect(events).toContain("confirmation-requested");
    expect(events).toContain("confirmation-resolved");
    expect(
      surface
        .events()
        .some(
          (e) =>
            e.type === "invocation-settled" &&
            e.capabilityId === "domain:devices.disable" &&
            e.status === "ok",
        ),
    ).toBe(true);

    // The agent put the view back the way it found it (last scenario step),
    // and the UI refetched: the rows are visible again, now disabled —
    // a reactive consequence owned by the app, not by the library.
    await waitFor(() => {
      expect(surface.view.getByTestId("status-dev_1").textContent).toBe("disabled");
    });
    const filters = await surface.observe<{ status: string; city: string | null }>(
      "view:devices.filters.read",
    );
    expect(filters).toEqual({ status: "all", city: null });

    toolset.dispose();
    surface.dispose();
  });

  it("denial branch: the user declines, the agent must not retry", async () => {
    const { surface } = await renderApp();
    await surface.invoke("view:devices.table.selectRows", { ids: ["dev_1"], mode: "replace" });
    const first = await surface.invoke("domain:devices.disable", {});
    expect(first).toFailWith("CONFIRMATION_REQUIRED");
    await act(async () => {});
    surface.view.getByTestId("confirmation-deny").click();
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    const denied = await surface.invoke("domain:devices.disable", {}, { confirmationId });
    expect(denied).toFailWith("CONFIRMATION_INVALID", { reason: "denied" });
    surface.dispose();
  });

  it("bait-and-switch branch: selection changed after approval ⇒ mismatch", async () => {
    const { surface } = await renderApp();
    await surface.invoke("view:devices.table.selectRows", { ids: ["dev_1"], mode: "replace" });
    const first = await surface.invoke("domain:devices.disable", {});
    expect(first).toFailWith("CONFIRMATION_REQUIRED");
    surface.confirmations.approve();
    await surface.invoke("view:devices.table.selectRows", { ids: ["dev_2"], mode: "replace" });
    const confirmationId =
      first.status === "error" ? (first.error.details?.confirmationId as string) : "";
    const result = await surface.invoke("domain:devices.disable", {}, { confirmationId });
    expect(result).toFailWith("CONFIRMATION_INVALID", { reason: "mismatch" });
    surface.dispose();
  });

  it("locked binding: the model cannot smuggle its own deviceIds", async () => {
    const { surface } = await renderApp();
    await surface.invoke("view:devices.table.selectRows", { ids: ["dev_1"] });
    const result = await surface.invoke("domain:devices.disable", { deviceIds: ["dev_5"] });
    expect(result).toFailWith("INVALID_INPUT", { lockedFields: ["deviceIds"] });
    surface.dispose();
  });
});

describe("presentation capabilities", () => {
  it("filters.set patches; the table refetches through the app's data layer", async () => {
    const { surface } = await renderApp();
    await surface.invoke("view:devices.filters.set", { status: "offline", city: "Milano" });
    await act(async () => {});
    const state = await surface.observe<{ visibleRows: Array<{ id: string }> }>(
      "view:devices.table.readState",
    );
    expect(state.visibleRows.map((r) => r.id)).toEqual(["dev_1", "dev_2", "dev_3"]);
    const filters = await surface.observe<{ status: string; city: string | null }>(
      "view:devices.filters.read",
    );
    expect(filters).toEqual({ status: "offline", city: "Milano" });
    surface.dispose();
  });

  it("sort is idempotent and reorders the visible rows", async () => {
    const { surface } = await renderApp();
    await surface.invoke("view:devices.table.sort", { by: "name", dir: "desc" });
    await act(async () => {});
    const state = await surface.observe<{ visibleRows: Array<{ name: string }> }>(
      "view:devices.table.readState",
    );
    const names = state.visibleRows.map((r) => r.name);
    expect(names).toEqual([...names].sort().reverse());
    const descriptor = surface
      .snapshot()
      .components.find((c) => c.type === "devices.table")!
      .actions.find((a) => a.name === "sort")!;
    expect(descriptor.idempotent).toBe(true);
    surface.dispose();
  });

  it("the human path disables through the app's own client (no agent, no evidence)", async () => {
    const { wiring, surface } = await renderApp();
    try {
      // Select two rows the way a person would: clicking checkboxes.
      act(() => {
        surface.view.getByLabelText("Select Duomo Nord").click();
        surface.view.getByLabelText("Select Navigli Est").click();
      });
      // The app shows its OWN confirm for the human path — a plain dialog it
      // owns, not the agent approval host, which is never involved here.
      act(() => {
        surface.view.getByTestId("disable-selected").click();
      });
      expect(surface.view.getByTestId("human-confirm-dialog")).toBeTruthy();
      act(() => {
        surface.view.getByTestId("human-confirm").click();
      });
      await waitFor(() => {
        expect(wiring.backend.devices.find((d) => d.id === "dev_1")?.status).toBe("disabled");
        expect(wiring.backend.devices.find((d) => d.id === "dev_2")?.status).toBe("disabled");
      });
      const call = wiring.backend.calls.find((c) => c.path === "devices.disable")!;
      expect(call.input).toEqual({ deviceIds: ["dev_1", "dev_2"], reason: "operator-ui" });
      // No confirmation evidence: that protocol governs AGENTS, not the user
      // whose own click it is. The server re-validated either way.
      expect(call.context).toBeUndefined();
      expect(surface.events().some((e) => e.type === "confirmation-requested")).toBe(false);
    } finally {
      surface.dispose();
    }
  });

  it("drawer: open validates the id, close is gated on state", async () => {
    const { surface } = await renderApp();
    const bad = await surface.invoke("view:devices.drawer.open", { deviceId: "ghost" });
    expect(bad).toFailWith("PRECONDITION_FAILED");
    const ok = await surface.invoke("view:devices.drawer.open", { deviceId: "dev_1" });
    expect(ok).toBeOk();
    await act(async () => {});
    expect(surface.view.getByTestId("device-drawer").textContent).toContain("Duomo Nord");
    expect(surface).toExpose("view:devices.drawer.close");
    await surface.invoke("view:devices.drawer.close", {});
    await act(async () => {});
    expect(surface.view.queryByTestId("device-drawer")).toBeNull();
    surface.dispose();
  });

  it("navigation unmounts the page: late invocations fail typed; route updates", async () => {
    const { surface } = await renderApp();
    const versionBefore = surface.registry.getVersion();
    const goTo = await surface.invoke("view:app.navigation.goTo", { page: "reports" });
    expect(goTo).toBeOk();
    await act(async () => {});
    // React commits the route change after the action settles; the version
    // moves and adapters re-discover via surface-changed (docs/04).
    expect(surface.registry.getVersion()).not.toBe(versionBefore);
    expect(surface.view.getByTestId("reports-page")).toBeTruthy();
    expect(surface.snapshot().route).toEqual({ path: "/reports" });
    const late = await surface.invoke("view:devices.table.selectRows", { ids: ["dev_1"] });
    expect(late).toFailWith("COMPONENT_UNMOUNTED");
    surface.dispose();
  });

  it("staleness: a captured ref from before a route round-trip is rejected", async () => {
    const { surface } = await renderApp();
    const ref = surface.captureRef("view:devices.table.selectRows");
    await surface.invoke("view:app.navigation.goTo", { page: "reports" });
    await act(async () => {});
    await surface.invoke("view:app.navigation.goTo", { page: "devices" });
    await act(async () => {});
    const result = await surface.invoke(
      "view:devices.table.selectRows",
      { ids: ["dev_1"] },
      { registrationId: ref.registrationId },
    );
    expect(result).toFailWith("STALE_CAPABILITY", { reason: "registration-replaced" });
    surface.dispose();
  });

  it("two-instance page: targeting requires instanceId; procedures disambiguate by reference", async () => {
    const { surface } = await renderApp();
    await surface.invoke("view:app.navigation.goTo", { page: "comparison" });
    await act(async () => {});
    expect(
      surface.snapshot().components.filter((c) => c.type === "devices.table"),
    ).toHaveLength(2);

    const ambiguous = await surface.invoke("view:devices.table.readState");
    expect(ambiguous).toFailWith("AMBIGUOUS_INSTANCE");

    const main = await surface.invoke("view:devices.table.readState", undefined, {
      instanceId: "main",
    });
    expect(main).toBeOk();
    expect(main.status === "ok" && (main.output as { visibleRows: Array<{ city: string }> }).visibleRows.every((r) => r.city === "Milano")).toBe(true);

    // Two live references to the same procedure: the registrationId picks one.
    expect(surface.snapshot().procedures).toHaveLength(2);
    surface.dispose();
  });
});
