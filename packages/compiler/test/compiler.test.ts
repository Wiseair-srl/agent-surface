// Conformance: AS-COMPILER-001, AS-COMPILER-002, AS-COMPILER-003,
// AS-COMPILER-004, AS-CONTRACT-002.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { createCapabilityAuthority } from "@agent-surface/core";
import { canonicalManifestJson, compileCapabilityContract } from "../src/index.js";

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

async function compile(root: string) {
  return compileCapabilityContract({
    root,
    vite: {
      resolve: { alias: { "@agent-surface/core": CORE } },
      plugins: [virtualFixture()],
    },
  });
}

describe("production graph compiler", () => {
  it("collects aliases, lazy chunks, virtual modules, and duplicate capability ids", async () => {
    const manifest = await compile(fixture());
    expect(manifest.formatVersion).toBe(4);
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
});
