// Conformance: AS-CONTRACT-001, AS-CONTRACT-002, AS-CONTRACT-003, AS-CONTRACT-004,
// AS-EXPOSURE-001.
import { describe, expect, it } from "vitest";
import {
  actionContract,
  createAgentExposureGateway,
  createAgentSurfaceRegistry,
  defineAgentComponentContract,
  defineExternalAgentToolContract,
  fromJsonSchema,
  type CapabilityContractEntry,
  type CapabilityContractManifest,
  type CompiledCapabilityToken,
} from "../src/index.js";

const entry: CapabilityContractEntry = {
  declarationId: "src/panel.ts#panel",
  capabilityId: "view:fixture.panel.run",
  kind: "action",
  description: "Run",
  effect: "local-state",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  contractHash: "contract-hash",
  targets: ["web-production"],
  origin: "src/panel.ts",
};

const manifest: CapabilityContractManifest = {
  formatVersion: 3,
  compilerVersion: "test",
  targets: ["web-production"],
  capabilities: [entry],
  externalContracts: [],
  completeness: { status: "proven" },
  hash: "manifest-hash",
};

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
    {
      manifestHash,
      declarationId: entry.declarationId,
      capabilities: {
        [entry.capabilityId]: { ...token, manifestHash, contractHash },
      },
    },
  );
}

describe("compiled runtime ceiling", () => {
  it("accepts matching bindings and rejects raw, stale, or mismatched registrations", () => {
    const registry = createAgentSurfaceRegistry({ environment: "test", manifest });
    expect(
      registry.register(compiledPanel().bind({ actions: { run: { execute: () => undefined } } })).status,
    ).toBe("active");
    expect(() =>
      registry.register({ type: "raw.panel", description: "raw" }),
    ).toThrow("raw registration");

    const stale = createAgentSurfaceRegistry({ environment: "test", manifest });
    expect(() =>
      stale.register(compiledPanel("old").bind({ actions: { run: { execute: () => undefined } } })),
    ).toThrow("manifest hash mismatch");

    const mismatch = createAgentSurfaceRegistry({ environment: "test", manifest });
    expect(() =>
      mismatch.register(compiledPanel(manifest.hash, "wrong").bind({ actions: { run: { execute: () => undefined } } })),
    ).toThrow("contract hash mismatch");
  });

  it("rejects a raw provider tool at the final exposure boundary", () => {
    const externalEntry: CapabilityContractEntry = {
      ...entry,
      declarationId: "src/tool.ts#search",
      capabilityId: "external:search",
      kind: "external",
      effect: "read",
    };
    const externalManifest = { ...manifest, capabilities: [externalEntry] };
    const contract = defineExternalAgentToolContract(
      {
        id: "external:search",
        description: "Search",
        effect: "read",
        input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      },
      {
        manifestHash: manifest.hash,
        declarationId: externalEntry.declarationId,
        capabilityId: externalEntry.capabilityId,
        contractHash: externalEntry.contractHash,
      },
    );
    const gateway = createAgentExposureGateway(externalManifest);
    expect(gateway.expose([contract.bind({ execute: () => ({}) })])).toHaveLength(1);
    expect(() => gateway.expose([{ name: "raw", description: "raw", inputSchema: {}, execute: async () => ({}) }] as never))
      .toThrow("raw provider tool");
  });
});
