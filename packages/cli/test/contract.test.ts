// Conformance: AS-CLI-015, AS-CLI-016.
import { describe, expect, it } from "vitest";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import { diffContracts } from "../src/diff.js";
import { renderReport } from "../src/report.js";

function manifest(capabilities: CapabilityContractEntry[], hash = "hash"): CapabilityContractManifest {
  return {
    formatVersion: 3,
    compilerVersion: "test",
    targets: ["web-production"],
    capabilities,
    externalContracts: [],
    completeness: { status: "proven" },
    hash,
  };
}

const base: CapabilityContractEntry = {
  declarationId: "src/panel.ts#panel",
  capabilityId: "view:panel.run",
  kind: "action",
  description: "Run",
  effect: "local-state",
  confirmation: "required",
  policies: [{ name: "auth", phase: "authorize" }],
  contractHash: "a",
  targets: ["web-production"],
  origin: "src/panel.ts",
};

describe("canonical CLI diff model", () => {
  it("classifies widening, narrowing, and neutral changes without suppressing any", () => {
    const changes = diffContracts(
      manifest([base]),
      manifest([
        {
          ...base,
          description: "Run now",
          confirmation: "never",
          policies: [],
          targets: ["web-production", "worker-production"],
          contractHash: "b",
        },
      ]),
    );
    expect(changes.map((change) => [change.field, change.classification])).toEqual([
      ["confirmation", "widening"],
      ["description", "neutral"],
      ["policies", "widening"],
      ["targets", "widening"],
    ]);
  });

  it("derives GitHub and JSON output from the same diff", () => {
    const current = manifest([base]);
    const changes = diffContracts(undefined, current);
    const report = {
      command: "check" as const,
      status: "fail" as const,
      manifest: current,
      snapshotPath: ".agent-surface/contract.json",
      integrity: { status: "missing" as const, changes },
    };
    expect(JSON.parse(renderReport(report, "json")).integrity.changes).toHaveLength(1);
    expect(renderReport(report, "github")).toContain("::error");
    expect(renderReport(report, "github")).toContain("view:panel.run");
  });

  it("treats policy phase loss as widening", () => {
    const changes = diffContracts(
      manifest([base]),
      manifest([{ ...base, policies: [{ name: "auth" }], contractHash: "b" }]),
    );
    expect(changes).toMatchObject([{ field: "policies", classification: "widening" }]);
  });
});
