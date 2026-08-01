// Conformance: AS-CLI-001 (the rendered view shows every capability the
// snapshot contains, and the explanation's hidden ones on top).
import { describe, expect, it } from "vitest";
import type { AgentSurfaceSnapshot } from "@agent-surface/core";
import type { SurfaceExplanation } from "@agent-surface/core/explain";
import { buildView, flatRows } from "../src/render/model.js";
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
  it("shows every capability id the snapshot contains, and the hidden ones too", () => {
    const result = fixture();
    const view = buildView(result);

    const fromSnapshot = [
      ...result.snapshot.components.flatMap((component) => [
        ...component.observations.map((o) => o.capabilityId),
        ...component.actions.map((a) => a.capabilityId),
      ]),
      ...result.snapshot.procedures.map((p) => p.procedureId),
    ];
    const rendered = flatRows(view).map((row) => row.capabilityId);

    for (const id of fromSnapshot) expect(rendered).toContain(id);

    // Hidden capabilities appear without --explain, for the reason AS-CLI-007
    // moved the hidden *count* out from behind it: signed out, the example app
    // rendered `0 callable, 0 visible-disabled` over eleven capabilities that
    // authority had hidden, and a reader who did not know to pass a flag read
    // that as an app which annotated nothing.
    expect(rendered).toContain("view:devices.admin.purge");
    // The attribution is what still needs the flag.
    expect(flatRows(view).find((r) => r.outcome === "hide")?.policies).toBeUndefined();
  });

  it("never prints an availability reason on a hidden row", () => {
    // Authority hides, state discloses (D11/D12). The reason a hidden
    // capability carries is its *availability* reason, and printing it under a
    // row marked `hidden` says the UI declined when a policy did — the two
    // failures must never look alike.
    const result = fixture();
    result.explanation.capabilities.push({
      capabilityId: "view:devices.admin.wipe",
      kind: "action",
      plane: "view",
      description: "Wipe",
      registrationId: "reg_4",
      component: { type: "devices.admin", instanceId: "default" },
      outcome: "hide",
      reason: "Nothing selected",
      policies: [],
      availability: { available: false, reason: "Nothing selected" },
    });

    const hidden = flatRows(buildView(result)).find(
      (row) => row.capabilityId === "view:devices.admin.wipe",
    );
    expect(hidden?.outcome).toBe("hide");
    expect(hidden?.reason).toBeUndefined();
  });

  it("carries the metadata a reviewer needs: effect, confirmation, bound fields, reason", () => {
    const rows = flatRows(buildView(fixture()));

    const sort = rows.find((r) => r.capabilityId === "view:devices.table.sort");
    expect(sort?.tags).toEqual(["local-state", "idempotent", "reversible"]);
    // The table splits the effect into its own column; the detail view keeps
    // the combined list. Both come from one model, so they cannot disagree.
    expect(sort?.effect).toBe("local-state");
    expect(sort?.flags).toEqual(["idempotent", "reversible"]);
    expect(sort?.path).toBe("devices.table.sort");
    expect(sort?.outcome).toBe("expose");

    const clear = rows.find((r) => r.capabilityId === "view:devices.table.clear");
    expect(clear?.flags).toContain("confirmation:required");
    expect(clear?.outcome).toBe("disable");
    expect(clear?.reason).toBe("Nothing selected");

    const disable = rows.find((r) => r.capabilityId === "domain:devices.disable");
    expect(disable?.effect).toBe("destructive");
    expect(disable?.flags).toContain("deviceIds bound+locked");
    expect(disable?.reason).toBe("Select at least one device first");

    // An observation reads state and has no effect at all — the table shows an
    // em dash rather than inventing one.
    expect(rows.find((r) => r.kind === "observation")?.effect).toBeUndefined();
  });

  it("attaches the policy chain only under --explain", () => {
    const view = buildView(fixture(), { explain: true });
    const hiddenGroup = view.groups.find((group) => group.heading.startsWith("hidden by policy"));

    expect(hiddenGroup?.rows.map((row) => row.capabilityId)).toEqual([
      "view:devices.admin.purge",
    ]);
    expect(hiddenGroup?.rows[0]?.policies?.[0]?.name).toBe("has-permission(devices:admin)");
    expect(view.counts).toEqual({ callable: 2, disabled: 2, hidden: 1 });
  });

  it("the detail view reports the same capabilities as the view model", () => {
    const view = buildView(fixture(), { explain: true });
    const text = renderSurfacePlain(view, { detail: true });
    for (const row of flatRows(view)) expect(text).toContain(row.name);
    expect(text).toContain("policy has-permission(devices:admin)");
    expect(text).toContain("Select at least one device first");
  });

  it("the table reports the same capabilities, one per line", () => {
    const view = buildView(fixture());
    const text = renderSurfacePlain(view);
    for (const row of flatRows(view)) expect(text).toContain(row.path);
    expect(text).toContain("CAPABILITY");
    // The reason is a continuation line rather than a column, so one long
    // sentence cannot set the width of the whole grid.
    expect(text).toContain("⤷ Nothing selected");
  });

  it("lays the table out from its content, never from the terminal (AS-CLI-003)", () => {
    // A table sized against `process.stdout.columns` is byte-stable only until
    // two people diff the same CI log from different windows.
    const view = buildView(fixture());
    const wide = { ...process.stdout, columns: 400 };
    const narrow = { ...process.stdout, columns: 40 };

    const original = Object.getOwnPropertyDescriptor(process, "stdout")!;
    try {
      Object.defineProperty(process, "stdout", { value: wide, configurable: true });
      const atFourHundred = renderSurfacePlain(view);
      Object.defineProperty(process, "stdout", { value: narrow, configurable: true });
      expect(renderSurfacePlain(view)).toBe(atFourHundred);
    } finally {
      Object.defineProperty(process, "stdout", original);
    }
  });

  it("emits no trailing whitespace, which diff tools disagree about", () => {
    const text = renderSurfacePlain(buildView(fixture()));
    for (const line of text.split("\n")) expect(line).toBe(line.trimEnd());
  });
});
