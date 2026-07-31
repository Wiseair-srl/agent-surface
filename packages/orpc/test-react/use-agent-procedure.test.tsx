// Conformance: AS-BIND-004 (useAgentProcedure lifecycle + context link)
import { useState } from "react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  observation,
  type JsonValue,
} from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import { createOrpcAgentBridge, type OrpcAgentManifest } from "@agent-surface/orpc";
import { useAgentProcedure } from "@agent-surface/orpc/react";
import { renderAgentSurface } from "@agent-surface/testing/react";
import { matchers } from "@agent-surface/testing/matchers";

expect.extend(matchers);

interface DisableInput {
  deviceIds: string[];
  reason?: string;
}

const manifest: OrpcAgentManifest = {
  tools: {
    "devices.disable": {
      description: "Disable the given devices",
      inputSchema: {
        type: "object",
        properties: {
          deviceIds: { type: "array", items: { type: "string" }, minItems: 1 },
          reason: { type: "string" },
        },
        required: ["deviceIds"],
        additionalProperties: false,
      },
      effect: "destructive",
    },
  },
};

const ROWS = [
  { id: "d1", status: "offline", city: "Milano" },
  { id: "d2", status: "offline", city: "Milano" },
  { id: "d3", status: "online", city: "Roma" },
];

/** Mirrors the docs/10 setup: registry + bridge wired BEFORE any rendering. */
function makeApp(log: Array<{ input: unknown }> = []) {
  const bridge = createOrpcAgentBridge({
    client: {
      devices: {
        disable: async (input: DisableInput) => {
          log.push({ input });
          return { disabled: input.deviceIds.length };
        },
      },
    },
    manifest,
  });
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  registry.setProcedureExecutor(bridge.executor);
  return { bridge, registry, log };
}

function DevicesPage(props: { bridge: ReturnType<typeof makeApp>["bridge"] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useAgentComponent({
    type: "devices.table",
    description: "Table of devices matching the active filters",
    observations: {
      readState: observation({
        description: "Visible rows and selection",
        output: fromJsonSchema<JsonValue>({ type: "object", additionalProperties: true }),
        read: () => ({ visibleRows: ROWS, selectedIds }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace the row selection",
        input: fromJsonSchema<{ ids: string[] }>({
          type: "object",
          properties: { ids: { type: "array", items: { type: "string" }, minItems: 1 } },
          required: ["ids"],
          additionalProperties: false,
        }),
        effect: "local-state",
        execute: ({ ids }) => setSelectedIds(ids),
      }),
    },
  });

  useAgentProcedure(props.bridge.refs.devices.disable, {
    when: () => selectedIds.length > 0,
    unavailableReason: "Select at least one device first",
    bind: () => ({ deviceIds: selectedIds }),
    confirmation: "required",
    describe: () => `Currently bound to the ${selectedIds.length} selected device(s)`,
  });

  return null;
}

describe("useAgentProcedure (docs/05, docs/10 scenario)", () => {
  it("exposes the reference contextually, linked to the owning component", async () => {
    const { bridge, registry } = makeApp();
    const surface = await renderAgentSurface(<DevicesPage bridge={bridge} />, { registry });

    expect(surface).toExposeUnavailable("domain:devices.disable", {
      reason: "Select at least one device first",
    });
    const descriptor = surface.snapshot().procedures[0]!;
    expect(descriptor.context).toEqual({ type: "devices.table", instanceId: "default" });
    expect(descriptor.boundFields).toEqual([
      { path: "deviceIds", locked: true, source: "ui-state" },
    ]);
    expect(descriptor.confirmation).toBe("required");
    surface.dispose();
  });

  it("runs the full disable flow end to end (docs/10, no LLM)", async () => {
    const { bridge, registry, log } = makeApp();
    const surface = await renderAgentSurface(<DevicesPage bridge={bridge} />, { registry });

    const state = await surface.observe<{ visibleRows: Array<{ id: string; status: string }> }>(
      "view:devices.table.readState",
    );
    const offline = state.visibleRows.filter((r) => r.status === "offline").map((r) => r.id);
    await surface.invoke("view:devices.table.selectRows", { ids: offline });
    await act(async () => {});

    // Selection non-empty ⇒ the procedure became available (availability push).
    expect(surface).toExpose("domain:devices.disable");
    expect(surface.snapshot().procedures[0]!.contextualNote).toContain(
      "Currently bound to the 2 selected device(s)",
    );

    let result = await surface.invoke("domain:devices.disable", {});
    expect(result).toFailWith("CONFIRMATION_REQUIRED");
    surface.confirmations.approve();
    const confirmationId =
      result.status === "error" ? (result.error.details?.confirmationId as string) : "";
    result = await surface.invoke("domain:devices.disable", {}, { confirmationId });
    expect(result).toBeOk();
    expect(result.status === "ok" && result.output).toEqual({ disabled: 2 });
    expect(log[0]?.input).toEqual({ deviceIds: ["d1", "d2"] });

    // Locked binding cannot be overridden by the agent.
    const locked = await surface.invoke("domain:devices.disable", { deviceIds: ["victim"] });
    expect(locked).toFailWith("INVALID_INPUT", { lockedFields: ["deviceIds"] });
    surface.dispose();
  });

  it("unregisters the reference on unmount", async () => {
    const { bridge, registry } = makeApp();
    const surface = await renderAgentSurface(<DevicesPage bridge={bridge} />, { registry });
    expect(surface.snapshot().procedures).toHaveLength(1);
    surface.unmount();
    expect(surface.snapshot().procedures).toHaveLength(0);
    surface.dispose();
  });

  it("a non-manifest ref registers nothing and logs (exposure gating)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry } = makeApp();
    const fakeRef = {
      id: "domain:devices.explode",
      path: "devices.explode",
      description: "not exposed by the manifest",
      inputSchema: { type: "object" },
      effect: "destructive" as const,
      call: async () => ({}),
    };
    function Page() {
      useAgentProcedure(fakeRef, {});
      return null;
    }
    const surface = await renderAgentSurface(<Page />, { registry });
    expect(surface.snapshot().procedures).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    surface.dispose();
  });
});
