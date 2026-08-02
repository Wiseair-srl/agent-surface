// Conformance: AS-COMPILER-001, AS-COMPILER-002, AS-COMPILER-003,
// AS-COMPILER-004, AS-CONTRACT-002.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Plugin } from "vite";
import { createCapabilityAuthority } from "@agent-surface/core";
import type { ExternalContractPolicy } from "../src/plugin.js";
import {
  agentSurface,
  canonicalJson,
  canonicalManifestJson,
  compileCapabilityContract,
  computeManifestHash,
  sha256,
  VIRTUAL_CONTRACT_ID,
} from "../src/index.js";

const CORE = fileURLToPath(new URL("../../core/src/index.ts", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(dynamic = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-surface-compiler-")));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "index.html"),
    '<script type="module" src="/src/main.ts"></script>\n',
  );
  writeFileSync(
    join(root, "src/main.ts"),
    'import "./direct.js"; import("./lazy.js"); import "virtual:fixture-capability";\n',
  );
  writeFileSync(
    join(root, "src/direct.ts"),
    dynamic
      ? `import { defineAgentComponentContract } from "@agent-surface/core";
         const type = globalThis.location.pathname;
         export const bad = defineAgentComponentContract({ type, description: "bad" });`
      : `import { defineAgentComponentContract as define, observationContract, fromJsonSchema } from "@agent-surface/core";
         const assigned = define;
         export const direct = assigned({
           type: "fixture.panel", description: "Panel",
           policies: [{ name: "session", phase: "authorize" }], tags: ["fixture"],
           observations: { state: observationContract({ description: "State", output: fromJsonSchema({ type: "string" }) }) }
         });`,
  );
  writeFileSync(
    join(root, "src/lazy.ts"),
    `import * as Surface from "@agent-surface/core";
     export const duplicate = Surface["defineAgentComponentContract"]({
       type: "fixture.panel", description: "Lazy panel",
       actions: { run: Surface.actionContract({ description: "Run", input: Surface.fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }), effect: "local-state" }) }
     });`,
  );
  return root;
}

function virtualFixture(): Plugin {
  return {
    name: "fixture-virtual",
    resolveId(id) {
      return id === "virtual:fixture-capability" ? "\0fixture:virtual" : null;
    },
    load(id) {
      if (id !== "\0fixture:virtual") return null;
      return `import { defineExternalAgentToolContract, fromJsonSchema } from "@agent-surface/core";
        export const virtualTool = defineExternalAgentToolContract({
          id: "external:virtual.search", description: "Search", effect: "read",
          input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false })
        });`;
    },
  };
}

/**
 * A dependency installed into the fixture's node_modules that ships a compiled
 * contract sidecar — the auto-discovery route, which is the one a consumer
 * never opts into and therefore the one authorization has to govern.
 */
function installVendorPackage(root: string, capabilityId = "domain:pinned.run"): string {
  const dir = join(root, "node_modules/@vendor/plugin");
  mkdirSync(dir, { recursive: true });
  const entry = {
    declarationId: "vendor/plugin.ts#pinned",
    capabilityId,
    kind: "procedure" as const,
    description: "Pinned",
    effect: "server-mutation" as const,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    origin: "vendor/plugin.ts",
  };
  const capability = { ...entry, contractHash: sha256(canonicalJson(entry)), targets: ["web-production"] };
  const payload = {
    formatVersion: 5 as const,
    compilerVersion: "vendor",
    targets: ["web-production"],
    capabilities: [capability],
    externalContracts: [],
    completeness: { status: "proven" as const },
  };
  const manifest = { ...payload, hash: computeManifestHash(payload) };
  const bytes = Buffer.from(canonicalManifestJson(manifest), "utf8");
  writeFileSync(join(dir, "contract.json"), bytes);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@vendor/plugin",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      agentSurface: { contract: "contract.json" },
    }),
  );
  writeFileSync(join(dir, "index.js"), "export const vendor = 1;\n");
  writeFileSync(
    join(root, "src/main.ts"),
    'import "./direct.js"; import("./lazy.js"); import "virtual:fixture-capability"; import "@vendor/plugin";\n',
  );
  return sha256(bytes);
}

async function compile(root: string, externalContracts?: ExternalContractPolicy) {
  return compileCapabilityContract({
    root,
    ...(externalContracts ? { externalContracts } : {}),
    vite: {
      resolve: { alias: { "@agent-surface/core": CORE } },
      plugins: [virtualFixture()],
    },
  });
}

describe("production graph compiler", () => {
  it("collects aliases, lazy chunks, virtual modules, and duplicate capability ids", async () => {
    const manifest = await compile(fixture());
    expect(manifest.formatVersion).toBe(5);
    expect(manifest.completeness.status).toBe("proven");
    expect(manifest.capabilities.map((entry) => entry.capabilityId)).toEqual([
      "view:fixture.panel.state",
      "view:fixture.panel.run",
      "external:virtual.search",
    ]);
    expect(manifest.capabilities.filter((entry) => entry.capabilityId.startsWith("view:fixture.panel")))
      .toHaveLength(2);
    expect(manifest.capabilities[0]?.policies).toEqual([{ name: "session", phase: "authorize" }]);
    expect(manifest.capabilities[0]?.tags).toEqual(["fixture"]);
    const authority = createCapabilityAuthority(manifest);
    expect(authority.manifest.hash).toBe(manifest.hash);
    expect(Object.isFrozen(authority.manifest.capabilities)).toBe(true);
  });

  it("is byte-identical across checkout paths", async () => {
    const a = await compile(fixture());
    const b = await compile(fixture());
    expect(canonicalManifestJson(a)).toBe(canonicalManifestJson(b));
  });

  it("fails dynamic contract construction; no unresolved bucket exists", async () => {
    await expect(compile(fixture(true))).rejects.toThrow("dynamic");
  });

  // AS-EXTERNAL-001: a dependency reachable from the production graph is
  // discovered automatically — and that alone must not admit its capabilities.
  it("refuses an unapproved dependency and prints the entry to add", async () => {
    const root = fixture();
    const digest = installVendorPackage(root);
    await expect(compile(root)).rejects.toThrow(
      new RegExp(`unauthorized external capability contract[\\s\\S]*@vendor/plugin[\\s\\S]*${digest}`),
    );
  });

  // AS-EXTERNAL-002: integrity and consent are separate facts, both recorded.
  it("admits an approved dependency and records both digests", async () => {
    const root = fixture();
    const digest = installVendorPackage(root);
    const manifest = await compile(root, { allow: [{ package: "@vendor/plugin", digest }] });

    expect(manifest.externalContracts).toEqual([
      {
        package: "@vendor/plugin",
        source: "node_modules/@vendor/plugin/contract.json",
        route: "sidecar",
        contractDigest: digest,
        authorization: { mode: "pinned", expectedDigest: digest },
      },
    ]);
    expect(manifest.capabilities.map((entry) => entry.capabilityId)).toContain("domain:pinned.run");
  });

  // AS-EXTERNAL-003: an approved dependency that changes what it contributes
  // fails until a human reviews the change, rather than riding the old consent.
  it("fails when an approved dependency changed, naming both digests", async () => {
    const root = fixture();
    const stale = installVendorPackage(root, "domain:pinned.escalated");
    await expect(
      compile(root, { allow: [{ package: "@vendor/plugin", digest: "0".repeat(64) }] }),
    ).rejects.toThrow(new RegExp(`digest mismatch[\\s\\S]*approved 0{64}[\\s\\S]*computed ${stale}`));
  });
});

/**
 * The dev server and the test runner are the same pipeline, and neither runs
 * Rollup's output hooks. Everything the build defers to `renderChunk` therefore
 * has to be resolved before the first module is served, or a consumer gets an
 * app that only works when bundled: `virtual:agent-surface-contract` fails to
 * resolve, and any proof that did get injected carries a placeholder hash no
 * authority can match.
 */
describe("serve mode", () => {
  /**
   * A project with a real `vite.config.ts`, because that is what the eager
   * compile in `buildStart` re-reads — the same config the dev server itself
   * was started from. A fixture whose plugins existed only as inline objects
   * would be resolvable by the outer server and invisible to the inner build.
   */
  function serveFixture(): string {
    const root = fixture();
    // Drop the virtual-module import: that plugin is inline-only, and the
    // build tests already cover it.
    writeFileSync(join(root, "src/main.ts"), 'import "./direct.js"; import("./lazy.js");\n');
    return root;
  }

  /**
   * Deliberately configured INLINE, with no config file — the shape a vitest
   * setup has. The eager compile has to inherit this resolution, or it
   * compiles against modules the server never serves.
   */
  function serve(root: string) {
    return createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false },
      resolve: { alias: { "@agent-surface/core": CORE } },
      plugins: [agentSurface()],
    });
  }

  it("serves a real authority and proofs that match it, with no build", async () => {
    const root = serveFixture();
    const server = await serve(root);
    try {
      const virtual = await server.transformRequest(VIRTUAL_CONTRACT_ID);
      expect(virtual?.code).toBeTruthy();
      // The manifest is inlined, not left as a placeholder for a hook that
      // never runs — the exact failure that made dev and vitest unusable.
      expect(virtual!.code).not.toMatch(/__AGENT_SURFACE_MANIFEST/);

      const manifest = await compileCapabilityContract({
        root,
        vite: { configFile: false, resolve: { alias: { "@agent-surface/core": CORE } } },
      });
      expect(virtual!.code).toContain(manifest.hash);

      // And the proof the transform stamps into a contract module agrees with
      // that manifest, which is what `assertDefinitionAuthorized` compares.
      const direct = await server.transformRequest("/src/direct.ts");
      expect(direct?.code).toBeTruthy();
      expect(direct!.code).not.toMatch(/__AGENT_SURFACE_MANIFEST/);
      expect(direct!.code).toContain(manifest.hash);
    } finally {
      await server.close();
    }
  });

  it("leaves Vite's optimized dependency chunks alone", async () => {
    const root = serveFixture();
    mkdirSync(join(root, "node_modules/.vite/deps"), { recursive: true });
    // Optimizer output is several dependencies concatenated, agent-surface
    // among them. Reading the guard patterns back out of a vendor chunk used to
    // refuse to serve the app at all.
    writeFileSync(
      join(root, "node_modules/.vite/deps/vendor.js"),
      "export function r(){ registry.register({ type: 'x' }); }\n",
    );
    const server = await serve(root);
    try {
      await expect(
        server.transformRequest("/node_modules/.vite/deps/vendor.js"),
      ).resolves.toBeTruthy();
    } finally {
      await server.close();
    }
  });
});
