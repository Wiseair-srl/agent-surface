// Conformance: AS-CLI-001, AS-CLI-015, AS-CLI-016, AS-EXTERNAL-004.
import { describe, expect, it, vi } from "vitest";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import { main } from "../src/bin.js";
import { diffContracts } from "../src/diff.js";
import { renderReport } from "../src/report.js";

function manifest(capabilities: CapabilityContractEntry[], hash = "hash"): CapabilityContractManifest {
  return {
    formatVersion: 5,
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

describe("human inspect view", () => {
  const second: CapabilityContractEntry = {
    ...base,
    declarationId: "src/table.ts#table",
    capabilityId: "view:table.read",
    kind: "observation",
    description: "Read the rows",
    effect: "read",
    confirmation: "never",
    policies: [],
  };
  const report = {
    command: "inspect" as const,
    status: "view" as const,
    manifest: manifest([base, second]),
    snapshotPath: "/repo/.agent-surface/contract.json",
    integrity: { status: "current" as const, changes: [] },
  };

  // AS-CLI-001: the view is the inventory. A rendered capability the snapshot
  // holds but the view drops is a capability nobody reviews.
  it("prints every capability once, grouped under the declaration that owns it", () => {
    const text = renderReport(report, "human");
    expect(text).toContain("REPOSITORY CONTRACT · 2 capabilities · 2 declarations");
    for (const entry of [base, second]) {
      expect(text).toContain(entry.capabilityId);
      // The declaration is a heading, so it is written once however many
      // capabilities hang off it — the repetition per row was the noise.
      expect(text.split(entry.declarationId)).toHaveLength(2);
    }
  });

  it("keeps the inventory out of a gate's way until --detail asks for it", () => {
    const gate = { ...report, command: "check" as const, status: "fail" as const };
    expect(renderReport(gate, "human")).not.toContain("REPOSITORY CONTRACT");
    expect(renderReport(gate, "human", { detail: true })).toContain(base.capabilityId);
  });

  it("shows obligations by default and prose only under --detail", () => {
    const plain = renderReport(report, "human");
    expect(plain).toContain("confirm:required");
    expect(plain).toContain("policy:auth@authorize");
    expect(plain).not.toContain("Read the rows");

    const detailed = renderReport(report, "human", { detail: true });
    expect(detailed).toContain("Read the rows");
    // `never` is a deliberate lowering: worth reading in detail, noise by default.
    expect(detailed).toContain("confirm:never");
    expect(plain).not.toContain("confirm:never");
  });

  it("shows the snapshot where the user would type it", () => {
    expect(renderReport(report, "human", { root: "/repo" })).toContain(".agent-surface/contract.json");
    expect(renderReport(report, "human", { root: "/repo" })).not.toContain("/repo/.agent-surface");
  });

  it("leaves the canonical JSON free of the checkout path", () => {
    expect(renderReport(report, "json", { root: "/repo", detail: true })).toBe(renderReport(report, "json"));
  });
});

describe("command line", () => {
  // pnpm and npm forward the `--` that separates their flags from the
  // script's. parseArgs turns whatever follows into positionals, so the run
  // used to die as `invalid command inspect` before compiling anything.
  it("accepts the separator a package manager forwards", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(main(["inspect", "--", "--help"])).resolves.toBe(0);
      await expect(main(["inspect", "--help"])).resolves.toBe(0);
    } finally {
      write.mockRestore();
    }
  });
});

describe("external contract approval", () => {
  // AS-EXTERNAL-004: the flag is how CI approves a dependency. A malformed pair
  // must exit loudly rather than compile with the approval silently dropped —
  // which would fail the build as unauthorized and read as the wrong problem.
  it("rejects an --allow pair that is not <package>=<sha256>", async () => {
    for (const value of ["@vendor/plugin", "@vendor/plugin=nope", "=".concat("a".repeat(64))]) {
      await expect(main(["check", "--allow", value])).resolves.toBe(2);
    }
  });
});
