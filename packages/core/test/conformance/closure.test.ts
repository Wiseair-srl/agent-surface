// Conformance: AS-CLOSURE-001, AS-CLOSURE-002, AS-CLOSURE-003, AS-CLOSURE-004,
// AS-ARTIFACT-001, AS-ARTIFACT-002, AS-ARTIFACT-003.
//
// The other conformance suites prove that each *known* boundary requires an
// authority; these prove that the set of boundaries is mechanically enumerated
// and that the published artifact ships no way around it. They read the built `dist` of every package, so CI must
// run `pnpm build` before `pnpm test` — as .github/workflows/ci.yml does.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInventory,
  checkClosure,
  publishedEntries,
  PROVING_CLASSES,
} from "../../../../scripts/lib/api-closure.mjs";
import {
  FORBIDDEN_SEAM_SYMBOLS,
  INTERNAL_ONLY_SYMBOLS,
  inspectPackedPackage,
} from "../../../../scripts/lib/published-artifact.mjs";
import {
  action,
  createAgentSurfaceRegistry,
  createCapabilityAuthority,
  defineAgentComponent,
  fromJsonSchema,
  observation,
  type CapabilityContractManifest,
} from "../../src/index.js";
import { disableUnsafeAuthorityTestMode, enableUnsafeAuthorityTestMode } from "../../src/contract.js";
import { sha256 } from "../../src/sha256.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const apiSurface = JSON.parse(readFileSync(join(root, "spec/api-surface.json"), "utf8")) as {
  classes: Record<string, string>;
  requires: Record<string, string>;
  modules: Record<string, Record<string, { kind: string; class: string; requires?: string; conformance?: string[] }>>;
};

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(",")}}`;
}

function emptyAuthority() {
  const payload = {
    formatVersion: 5 as const,
    compilerVersion: "test",
    targets: ["web-production"],
    capabilities: [],
    externalContracts: [],
    completeness: { status: "proven" as const },
  };
  const manifest: CapabilityContractManifest = {
    ...payload,
    hash: sha256(`${canonicalValue(payload)}\n`),
  };
  return createCapabilityAuthority(manifest);
}

describe("public API closure", () => {
  it("AS-CLOSURE-001: derives the inventory from every published exports subpath", { timeout: 60_000 }, () => {
    const entries = publishedEntries(root);
    expect(entries.length).toBeGreaterThan(0);
    // Every published subpath must resolve to a built declaration file, or the
    // gate would be silently reporting on a partial API.
    for (const entry of entries) {
      expect(entry.types, `${entry.id} declares no types condition`).toBeDefined();
      expect(existsSync(entry.types!), `${entry.id}: run "pnpm build" first`).toBe(true);
    }
    const { inventory, missing } = buildInventory(root);
    expect(missing).toEqual([]);
    expect(Object.keys(inventory).sort()).toEqual(entries.map((entry) => entry.id).sort());
    // The inventory is the real thing, not a stub: core exports its registry.
    expect(inventory["@agent-surface/core"]!["createAgentSurfaceRegistry"]).toBe("value");
  });

  it("AS-CLOSURE-002: the built API and the classification manifest agree", { timeout: 60_000 }, () => {
    expect(checkClosure(root)).toEqual([]);
  });

  it("AS-CLOSURE-002: an unclassified or stale export is a finding", () => {
    const { inventory } = buildInventory(root);
    const classified = new Set(Object.keys(apiSurface.modules["@agent-surface/core"]!));
    const built = new Set(Object.keys(inventory["@agent-surface/core"]!));
    // Both directions are checked by the gate, so neither set may drift.
    expect([...built].filter((name) => !classified.has(name))).toEqual([]);
    expect([...classified].filter((name) => !built.has(name))).toEqual([]);
  });

  it("AS-CLOSURE-003: create/expose/invoke boundaries cite implemented requirements", () => {
    const requirements = JSON.parse(readFileSync(join(root, "spec/conformance.json"), "utf8"))
      .requirements as Record<string, { status: string }>;
    let proving = 0;
    for (const [moduleId, symbols] of Object.entries(apiSurface.modules)) {
      for (const [name, entry] of Object.entries(symbols)) {
        if (!PROVING_CLASSES.has(entry.class)) continue;
        proving += 1;
        expect(entry.requires, `${moduleId}#${name}`).toBeDefined();
        expect(apiSurface.requires[entry.requires!], `${moduleId}#${name}`).toBeDefined();
        expect(entry.conformance?.length, `${moduleId}#${name}`).toBeGreaterThan(0);
        for (const id of entry.conformance!) {
          expect(requirements[id]?.status, `${moduleId}#${name} cites ${id}`).toBe("implemented");
        }
      }
    }
    // Guards against a manifest that trivially passes by classifying nothing.
    expect(proving).toBeGreaterThan(10);
  });

  it("AS-CLOSURE-004: inert exports cannot reach execution", () => {
    disableUnsafeAuthorityTestMode();
    try {
      const registry = createAgentSurfaceRegistry({ environment: "test", authority: emptyAuthority() });
      const raw = defineAgentComponent({
        type: "inert.panel",
        description: "Built by an inert export",
        observations: {
          state: observation({
            description: "State",
            output: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
            read: () => ({}),
          }),
        },
        actions: {
          run: action({
            description: "Run",
            input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
            effect: "local-state",
            execute: () => undefined,
          }),
        },
      });
      expect(() => registry.register(raw)).toThrow(
        /raw registration .* rejected: bind a compiler-generated contract/,
      );
      registry.dispose();
    } finally {
      enableUnsafeAuthorityTestMode();
    }
  });
});

describe("published artifact closure", () => {
  const packageDirs = [...new Set(publishedEntries(root).map((entry) => entry.package))].map(
    (name) => join(root, "packages", name.replace("@agent-surface/", "")),
  );

  it("AS-ARTIFACT-001/002/003: every package's shipped tree is closed", { timeout: 60_000 }, () => {
    // `dist` plus the manifest is exactly what `files` publishes; the CI script
    // asserts the same thing against a real `npm pack` tarball.
    for (const dir of packageDirs) {
      expect(inspectPackedPackage(dir), dir).toEqual([]);
    }
  });

  it("AS-ARTIFACT-002: a seam that survived bundling would be caught", () => {
    const fixture = mkdtempSync(join(tmpdir(), "closure-fixture-"));
    try {
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({
          name: "@fixture/leaky",
          exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
        }),
      );
      writeFileSync(join(fixture, "index.js"), `export function ${FORBIDDEN_SEAM_SYMBOLS[0]}() {}\n`);
      writeFileSync(join(fixture, "index.d.ts"), `export declare const ${INTERNAL_ONLY_SYMBOLS[0]}: () => boolean;\n`);
      const problems = inspectPackedPackage(fixture);
      expect(problems.some((problem) => problem.includes(FORBIDDEN_SEAM_SYMBOLS[0]!))).toBe(true);
      expect(problems.some((problem) => problem.includes(INTERNAL_ONLY_SYMBOLS[0]!))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("AS-ARTIFACT-001: a wildcard subpath would be caught", () => {
    const fixture = mkdtempSync(join(tmpdir(), "closure-wildcard-"));
    try {
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ name: "@fixture/wide", exports: { "./*": "./dist/*.js" } }),
      );
      expect(inspectPackedPackage(fixture).some((problem) => problem.includes("wildcard"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
