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
  it("prints every capability, compact and flat by default", () => {
    const text = renderReport(report, "human");
    expect(text).toContain("2 capabilities · 2 declarations");
    for (const entry of [base, second]) {
      expect(text).toContain(entry.capabilityId);
      // The declaration is provenance, not inventory: it moves to --verbosity
      // detail with the descriptions and the snapshot path.
      expect(text).not.toContain(entry.declarationId);
    }
    expect(text).not.toContain("REPOSITORY CONTRACT");
  });

  it("groups by declaration and shows provenance under --verbosity detail", () => {
    const text = renderReport(report, "human", { verbosity: "detail" });
    expect(text).toContain("REPOSITORY CONTRACT · 2 capabilities · 2 declarations");
    for (const entry of [base, second]) {
      expect(text).toContain(entry.capabilityId);
      // The declaration is a heading, so it is written once however many
      // capabilities hang off it — the repetition per row was the noise.
      expect(text.split(entry.declarationId)).toHaveLength(2);
    }
    for (const field of ["Contract", "Compiler", "Snapshot"]) expect(text).toContain(field);
  });

  it("stops at the headline under --verbosity min", () => {
    const text = renderReport(report, "human", { verbosity: "min" });
    expect(text).toContain("2 capabilities · 2 declarations");
    expect(text).toContain("snapshot current");
    expect(text).not.toContain("CAPABILITY");
  });

  it("keeps the inventory out of a gate's way until detail asks for it", () => {
    const gate = { ...report, command: "check" as const, status: "fail" as const };
    expect(renderReport(gate, "human")).not.toContain(base.capabilityId);
    expect(renderReport(gate, "human", { detail: true })).toContain(base.capabilityId);
    expect(renderReport(gate, "human", { verbosity: "detail" })).toContain(base.capabilityId);
  });

  it("labels its columns and fills an empty one rather than dropping it", () => {
    const text = renderReport(report, "human");
    for (const header of ["CAPABILITY", "KIND", "EFFECT", "REACH", "CONFIRM", "POLICIES"]) {
      expect(text).toContain(header);
    }
    // The declared obligations, in their own columns; "—" so the column reads.
    expect(text).toMatch(/view:panel\.run\s+action\s+local-state\s+low\s+required\s+auth@authorize/);
    expect(text).toMatch(/view:table\.read\s+observation\s+read\s+low\s+never\s+—/);
  });

  it("grades effect as a word, so a pipe keeps the signal a colour would carry", () => {
    const risky = {
      ...report,
      manifest: manifest([{ ...base, effect: "destructive", capabilityId: "view:panel.wipe" }]),
    };
    const text = renderReport(risky, "human");
    expect(text).toMatch(/view:panel\.wipe\s+action\s+destructive\s+high/);
    expect(text).toContain("reach 1 high");
  });

  it("keeps prose for detail and always says what it cannot know", () => {
    const plain = renderReport(report, "human");
    expect(plain).not.toContain("Read the rows");
    expect(renderReport(report, "human", { detail: true })).toContain("Read the rows");
    expect(renderReport(report, "human", { verbosity: "detail" })).toContain("Read the rows");
    // The contract is what production can declare; a policy's verdict needs a
    // real invocation. Saying so is part of the output, not a footnote to drop.
    expect(plain).toContain("not what a mount exposed at runtime");
  });

  // AS-CLI-003: colour is opt-in presentation. Uncoloured bytes are the
  // contract, and the coloured rendering differs only by ANSI sequences.
  it("keeps the uncoloured bytes as the contract when colour is on", () => {
    const plain = renderReport(report, "human");
    const colored = renderReport(report, "human", { color: true });
    expect(colored).not.toBe(plain);
    // eslint-disable-next-line no-control-regex
    expect(colored.replace(/\u001b\[[0-9]+m/g, "")).toBe(plain);
    expect(renderReport(report, "json", { color: true })).toBe(renderReport(report, "json"));
  });

  it("shows the snapshot where the user would type it", () => {
    const detail = { root: "/repo", verbosity: "detail" as const };
    expect(renderReport(report, "human", detail)).toContain(".agent-surface/contract.json");
    expect(renderReport(report, "human", detail)).not.toContain("/repo/.agent-surface");
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
