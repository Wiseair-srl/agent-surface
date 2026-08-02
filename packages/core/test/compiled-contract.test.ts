// Conformance: AS-CONTRACT-001, AS-CONTRACT-002, AS-CONTRACT-003, AS-CONTRACT-004,
// AS-AUTHORITY-001, AS-AUTHORITY-002, AS-AUTHORITY-003, AS-AUTHORITY-004,
// AS-EXPOSURE-001.
import { describe, expect, it } from "vitest";
import {
  actionContract,
  createAgentExposureGateway,
  createAgentSurfaceRegistry,
  createCapabilityAuthority,
  defineAgentComponentContract,
  defineExternalAgentToolContract,
  fromJsonSchema,
  type CapabilityAuthority,
  type CapabilityContractEntry,
  type CapabilityContractManifest,
} from "../src/index.js";
import {
  disableUnsafeAuthorityTestMode,
  enableUnsafeAuthorityTestMode,
  type CompiledCapabilityToken,
} from "../src/contract.js";
import { sha256 } from "../src/sha256.js";

function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(",")}}`;
}

const digest = (value: unknown): string => sha256(`${canonicalValue(value)}\n`);

function hashEntry(
  base: Omit<CapabilityContractEntry, "contractHash" | "targets">,
): CapabilityContractEntry {
  return { ...base, contractHash: digest(base), targets: ["web-production"] };
}

function buildManifest(capabilities: CapabilityContractEntry[]): CapabilityContractManifest {
  const payload = {
    formatVersion: 4 as const,
    compilerVersion: "test",
    targets: ["web-production"],
    capabilities,
    externalContracts: [],
    completeness: { status: "proven" as const },
  };
  return { ...payload, hash: digest(payload) };
}

const entry = hashEntry({
  declarationId: "src/panel.ts#panel",
  capabilityId: "view:fixture.panel.run",
  kind: "action",
  description: "Run",
  effect: "local-state",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  origin: "src/panel.ts",
});
const manifest = buildManifest([entry]);
const authority = createCapabilityAuthority(manifest);
const token: CompiledCapabilityToken = {
  manifestHash: manifest.hash,
  declarationId: entry.declarationId,
  capabilityId: entry.capabilityId,
  contractHash: entry.contractHash,
};

function compiledPanel(manifestHash = manifest.hash, contractHash = entry.contractHash) {
  return defineAgentComponentContract(
    {
      type: "fixture.panel",
      description: "Panel",
      actions: {
        run: actionContract({
          description: "Run",
          input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
          effect: "local-state",
        }),
      },
    },
    // @ts-expect-error compiler-only proof injection
    {
      manifestHash,
      declarationId: entry.declarationId,
      capabilities: {
        [entry.capabilityId]: { ...token, manifestHash, contractHash },
      },
    },
  );
}

describe("compiled runtime authority", () => {
  it("matches SHA-256 and compiler canonicalization", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("requires a genuine compiler authority", () => {
    disableUnsafeAuthorityTestMode();
    try {
      expect(() => createAgentSurfaceRegistry()).toThrow(
        "requires a compiler-generated capability authority",
      );
      expect(() =>
        createAgentSurfaceRegistry({ authority: { manifest } as CapabilityAuthority }),
      ).toThrow("invalid capability authority");
    } finally {
      enableUnsafeAuthorityTestMode();
    }
  });

  it("verifies and freezes the manifest snapshot", () => {
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.manifest)).toBe(true);
    expect(Object.isFrozen(authority.manifest.capabilities)).toBe(true);
    expect(() => createCapabilityAuthority({ ...manifest, hash: "tampered" })).toThrow(
      "compiled manifest hash is invalid",
    );
    expect(() =>
      createCapabilityAuthority({
        ...manifest,
        capabilities: [{ ...entry, description: "Tampered" }],
      }),
    ).toThrow("compiled contract hash is invalid");
  });

  it("accepts matching bindings; rejects raw, forged, stale, mismatched, or mutated ones", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test", authority });
    expect(
      registry.register(compiledPanel().bind({ actions: { run: { execute: () => undefined } } })).status,
    ).toBe("active");
    expect(() => registry.register({ type: "raw.panel", description: "raw" })).toThrow(
      "raw registration",
    );
    const forged = { type: "forged.panel", description: "forged" } as Record<PropertyKey, unknown>;
    forged[Symbol.for("agent-surface.compiled-capability-provenance")] = token;
    expect(() => registry.register(forged as never)).toThrow("raw registration");

    const stale = createAgentSurfaceRegistry({ environment: "test", authority });
    expect(() =>
      stale.register(compiledPanel("old").bind({ actions: { run: { execute: () => undefined } } })),
    ).toThrow("manifest hash mismatch");

    const mismatch = createAgentSurfaceRegistry({ environment: "test", authority });
    expect(() =>
      mismatch.register(
        compiledPanel(manifest.hash, "wrong").bind({ actions: { run: { execute: () => undefined } } }),
      ),
    ).toThrow("contract hash mismatch");

    const mutated = compiledPanel().bind({ actions: { run: { execute: () => undefined } } });
    mutated.actions!.run!.description = "Tampered";
    expect(() => registry.register(mutated)).toThrow("runtime description mismatch");
  });

  it("rejects raw provider tools at the final exposure boundary", () => {
    const externalEntry = hashEntry({
      declarationId: "src/tool.ts#search",
      capabilityId: "external:search",
      kind: "external",
      description: "Search",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      origin: "src/tool.ts",
    });
    const externalManifest = buildManifest([externalEntry]);
    const externalAuthority = createCapabilityAuthority(externalManifest);
    const contract = defineExternalAgentToolContract(
      {
        id: "external:search",
        description: "Search",
        effect: "read",
        input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      },
      // @ts-expect-error compiler-only proof injection
      {
        manifestHash: externalManifest.hash,
        declarationId: externalEntry.declarationId,
        capabilityId: externalEntry.capabilityId,
        contractHash: externalEntry.contractHash,
      },
    );
    const gateway = createAgentExposureGateway(externalAuthority);
    expect(gateway.expose([contract.bind({ execute: () => ({}) })])).toHaveLength(1);
    expect(() =>
      gateway.expose([
        { name: "raw", description: "raw", inputSchema: {}, execute: async () => ({}) },
      ] as never),
    ).toThrow("raw provider tool");
  });
});
