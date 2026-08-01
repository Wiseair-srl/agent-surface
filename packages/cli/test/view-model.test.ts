// Conformance: AS-CLI-001 (the rendered view shows every capability the
// snapshot contains, and the explanation's hidden ones on top).
import { describe, expect, it } from "vitest";
import type { AgentSurfaceSnapshot } from "@agent-surface/core";
import type { SurfaceExplanation } from "@agent-surface/core/explain";
import { buildView } from "../src/render/model.js";
import { renderSurfacePlain } from "../src/render/plain.js";
import type { CollectResult } from "../src/collect.js";

const emptySchema = { type: "object" } as const;

function fixture(): CollectResult {
  const snapshot: AgentSurfaceSnapshot = {
    surfaceId: "srf_test",
    surfaceVersion: "3",
    capturedAt: "2026-07-31T00:00:00.000Z",
    route: { path: "/devices" },
    components: [
      {
        type: "devices.table",
        instanceId: "default",
        registrationId: "reg_1",
        description: "Table",
        observations: [
          {
            capabilityId: "view:devices.table.readState",
            name: "readState",
            description: "Rows",
            outputSchema: emptySchema,
            available: true,
          },
        ],
        actions: [
          {
            capabilityId: "view:devices.table.sort",
            name: "sort",
            description: "Sort",
            inputSchema: emptySchema,
            effect: "local-state",
            idempotent: true,
            reversible: true,
            confirmation: "never",
            available: true,
          },
          {
            capabilityId: "view:devices.table.clear",
            name: "clear",
            description: "Clear",
            inputSchema: emptySchema,
            effect: "local-state",
            idempotent: false,
            reversible: false,
            confirmation: "required",
            available: false,
            unavailableReason: "Nothing selected",
          },
        ],
      },
    ],
    procedures: [
      {
        procedureId: "domain:devices.disable",
        description: "Disable",
        inputSchema: emptySchema,
        effect: "destructive",
        confirmation: "required",
        available: false,
        unavailableReason: "Select at least one device first",
        boundFields: [{ path: "deviceIds", locked: true, source: "ui-state" }],
        registrationId: "reg_2",
      },
    ],
  };

  const explanation: SurfaceExplanation = {
    surfaceId: "srf_test",
    surfaceVersion: "3",
    capturedAt: "2026-07-31T00:00:00.000Z",
    consumer: { id: "cli", kind: "test" },
    capabilities: [
      ...["readState", "sort"].map((name) => ({
        capabilityId: `view:devices.table.${name}`,
        kind: "action" as const,
        plane: "view" as const,
        description: name,
        registrationId: "reg_1",
        component: { type: "devices.table", instanceId: "default" },
        outcome: "expose" as const,
        policies: [],
        availability: { available: true },
      })),
      {
        capabilityId: "view:devices.table.clear",
        kind: "action",
        plane: "view",
        description: "Clear",
        registrationId: "reg_1",
        component: { type: "devices.table", instanceId: "default" },
        outcome: "disable",
        reason: "Nothing selected",
        policies: [],
        availability: { available: false, reason: "Nothing selected" },
      },
      {
        capabilityId: "domain:devices.disable",
        kind: "procedure",
        plane: "domain",
        description: "Disable",
        registrationId: "reg_2",
        component: { type: "orpc-ref", instanceId: "ref-1" },
        outcome: "disable",
        reason: "Select at least one device first",
        policies: [],
        availability: { available: false, reason: "Select at least one device first" },
      },
      {
        capabilityId: "view:devices.admin.purge",
        kind: "action",
        plane: "view",
        description: "Purge everything",
        registrationId: "reg_3",
        component: { type: "devices.admin", instanceId: "default" },
        outcome: "hide",
        policies: [
          {
            name: "has-permission(devices:admin)",
            scope: "registry",
            phases: ["discovery", "authorize"],
            discovery: { decision: "hide" },
          },
        ],
        availability: { available: true },
      },
    ],
  };

  return { scenario: "admin", snapshot, explanation, rejections: [] };
}

describe("the rendered view never loses a capability (AS-CLI-001)", () => {
  it("shows every capability id the snapshot contains", () => {
    const result = fixture();
    const view = buildView(result);

    const fromSnapshot = [
      ...result.snapshot.components.flatMap((component) => [
        ...component.observations.map((o) => o.capabilityId),
        ...component.actions.map((a) => a.capabilityId),
      ]),
      ...result.snapshot.procedures.map((p) => p.procedureId),
    ];
    const rendered = view.groups.flatMap((group) => group.rows.map((row) => row.capabilityId));

    for (const id of fromSnapshot) expect(rendered).toContain(id);
    // Without --explain, the hidden capability must not appear at all.
    expect(rendered).not.toContain("view:devices.admin.purge");
  });

  it("carries the metadata a reviewer needs: effect, confirmation, bound fields, reason", () => {
    const view = buildView(fixture());
    const rows = view.groups.flatMap((group) => group.rows);

    const sort = rows.find((r) => r.capabilityId === "view:devices.table.sort");
    expect(sort?.tags).toEqual(["local-state", "idempotent", "reversible"]);
    expect(sort?.outcome).toBe("expose");

    const clear = rows.find((r) => r.capabilityId === "view:devices.table.clear");
    expect(clear?.tags).toContain("confirmation:required");
    expect(clear?.outcome).toBe("disable");
    expect(clear?.reason).toBe("Nothing selected");

    const disable = rows.find((r) => r.capabilityId === "domain:devices.disable");
    expect(disable?.tags).toContain("destructive");
    expect(disable?.tags).toContain("deviceIds bound+locked");
    expect(disable?.reason).toBe("Select at least one device first");
  });

  it("surfaces hidden capabilities and their policy only under --explain", () => {
    const view = buildView(fixture(), { explain: true });
    const hiddenGroup = view.groups.find((group) => group.heading.startsWith("hidden by policy"));

    expect(hiddenGroup?.rows.map((row) => row.capabilityId)).toEqual([
      "view:devices.admin.purge",
    ]);
    expect(hiddenGroup?.rows[0]?.policies?.[0]?.name).toBe("has-permission(devices:admin)");
    expect(view.counts).toEqual({ callable: 2, disabled: 2, hidden: 1 });
  });

  it("plain rendering reports the same capabilities as the view model", () => {
    const view = buildView(fixture(), { explain: true });
    const text = renderSurfacePlain(view);
    for (const row of view.groups.flatMap((group) => group.rows)) {
      expect(text).toContain(row.name);
    }
    expect(text).toContain("policy has-permission(devices:admin)");
    expect(text).toContain("Select at least one device first");
  });
});
