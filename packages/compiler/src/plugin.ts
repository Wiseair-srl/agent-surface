import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_LIMITS,
  parseCapabilityId,
  validateJsonSchemaDocument,
} from "@agent-surface/core";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import type { Plugin } from "vite";
import { canonicalManifestJson, computeManifestHash, sha256, verifyManifest } from "./canonical.js";
import { extractModule } from "./extract.js";

export const COMPILER_VERSION = "0.16.0";
export const CONTRACT_FILE = "agent-surface.contract.json";
export const VIRTUAL_CONTRACT_ID = "virtual:agent-surface-contract";
const RESOLVED_VIRTUAL_CONTRACT_ID = `\0${VIRTUAL_CONTRACT_ID}`;

export interface PinnedContractInput {
  path: string;
  digest: string;
}

export interface AgentSurfaceCompilerOptions {
  target?: string;
  emit?: boolean;
  fileName?: string;
  externalContracts?: PinnedContractInput[];
  onManifest?: (manifest: CapabilityContractManifest) => void;
}

function mergeEntries(entries: CapabilityContractEntry[]): CapabilityContractEntry[] {
  const byKey = new Map<string, CapabilityContractEntry>();
  for (const entry of entries) {
    const key = `${entry.declarationId}\0${entry.capabilityId}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...entry, targets: [...entry.targets] });
      continue;
    }
    if (current.contractHash !== entry.contractHash) {
      throw new Error(`contract "${entry.declarationId}" / "${entry.capabilityId}" differs across build targets`);
    }
    current.targets = [...new Set([...current.targets, ...entry.targets])].sort();
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.declarationId}\0${a.capabilityId}`.localeCompare(`${b.declarationId}\0${b.capabilityId}`),
  );
}

function validateEntries(entries: readonly CapabilityContractEntry[]): void {
  for (const entry of entries) {
    if (entry.kind !== "external" && !parseCapabilityId(entry.capabilityId)) {
      throw new Error(`invalid compiled capability id "${entry.capabilityId}"`);
    }
    for (const [label, schema] of [["input", entry.inputSchema], ["output", entry.outputSchema]] as const) {
      if (!schema) continue;
      const result = validateJsonSchemaDocument(schema, DEFAULT_LIMITS);
      if (!result.ok) {
        throw new Error(`${entry.declarationId} ${label} schema: ${result.reason}`);
      }
    }
  }
}

function readPinnedContract(input: PinnedContractInput, root: string): CapabilityContractManifest {
  if (!input.digest) throw new Error(`external contract "${input.path}" is not content-addressed`);
  const path = isAbsolute(input.path) ? input.path : resolve(root, input.path);
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== input.digest) {
    throw new Error(`external contract "${input.path}" digest mismatch: expected ${input.digest}, got ${actual}`);
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as CapabilityContractManifest;
  verifyManifest(manifest);
  return manifest;
}

function nearestPackageSidecar(id: string, seen: Set<string>): string | undefined {
  if (id.startsWith("\0") || !isAbsolute(id)) return undefined;
  let dir = dirname(id.split("?")[0]!);
  while (dir !== dirname(dir)) {
    const packagePath = join(dir, "package.json");
    if (existsSync(packagePath)) {
      if (seen.has(packagePath)) return undefined;
      seen.add(packagePath);
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        agentSurface?: { contract?: string };
      };
      return pkg.agentSurface?.contract ? resolve(dir, pkg.agentSurface.contract) : undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}

export function agentSurface(options: AgentSurfaceCompilerOptions = {}): Plugin {
  const target = options.target ?? "web-production";
  const placeholder = `__AGENT_SURFACE_MANIFEST_HASH_${Math.random().toString(36).slice(2)}__`;
  const manifestPlaceholder = `__AGENT_SURFACE_MANIFEST_${Math.random().toString(36).slice(2)}__`;
  let root = process.cwd();
  let entries: CapabilityContractEntry[] = [];
  let manifest: CapabilityContractManifest | undefined;

  return {
    name: "agent-surface:compiler",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      return id === VIRTUAL_CONTRACT_ID ? RESOLVED_VIRTUAL_CONTRACT_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_CONTRACT_ID) return null;
      return `export default ${manifestPlaceholder};`;
    },
    buildStart() {
      entries = [];
      manifest = undefined;
    },
    transform(code, id) {
      if (
        id.includes("/node_modules/@agent-surface/") ||
        /\/packages\/(?:core|react|orpc|testing|webmcp|cli|compiler)\//.test(id)
      ) {
        return null;
      }
      if (/\buseAgentComponent\s*\(\s*\{/.test(code)) {
        throw new Error(`${id}: inline useAgentComponent registration is unsupported; bind a compiled contract`);
      }
      if (/\b(?:useAgentAction|useAgentObservation)\s*\(/.test(code)) {
        throw new Error(`${id}: granular runtime capability construction is unsupported by the compiled contract`);
      }
      if (/\bdefineAgentComponent\s*\(/.test(code) || /\bregistry\s*\.\s*register\s*\(\s*\{/.test(code)) {
        throw new Error(`${id}: raw capability registration bypasses the compiled exposure ceiling`);
      }
      if (
        !code.includes("defineAgentComponentContract") &&
        !code.includes("defineAgentProcedureContract") &&
        !code.includes("defineExternalAgentToolContract")
      ) {
        return null;
      }
      const extracted = extractModule({ code, id, root, target, placeholder });
      entries.push(...extracted.entries);
      return extracted.code === code ? null : { code: extracted.code, map: null };
    },
    buildEnd(error) {
      if (error) return;
      const externalContracts: CapabilityContractManifest["externalContracts"] = [];
      const externalEntries: CapabilityContractEntry[] = [];
      const seenPackages = new Set<string>();
      const sidecars = new Set<string>();
      for (const id of this.getModuleIds()) {
        const sidecar = nearestPackageSidecar(id, seenPackages);
        if (sidecar) sidecars.add(sidecar);
      }
      for (const sidecar of sidecars) {
        const bytes = readFileSync(sidecar);
        const external = JSON.parse(bytes.toString("utf8")) as CapabilityContractManifest;
        verifyManifest(external);
        externalEntries.push(...external.capabilities);
        externalContracts.push({ source: sidecar.split("/").slice(-3).join("/"), digest: sha256(bytes) });
      }
      for (const pinned of options.externalContracts ?? []) {
        const external = readPinnedContract(pinned, root);
        externalEntries.push(...external.capabilities);
        externalContracts.push({ source: pinned.path, digest: pinned.digest });
      }
      const capabilities = mergeEntries([...entries, ...externalEntries]);
      validateEntries(capabilities);
      const targets = [...new Set(capabilities.flatMap((entry) => entry.targets))].sort();
      const payload = {
        formatVersion: 3 as const,
        compilerVersion: COMPILER_VERSION,
        targets,
        capabilities,
        externalContracts: externalContracts.sort((a, b) => a.source.localeCompare(b.source)),
        completeness: { status: "proven" as const },
      };
      manifest = { ...payload, hash: computeManifestHash(payload) };
      options.onManifest?.(manifest);
    },
    renderChunk(code) {
      if (!manifest || (!code.includes(placeholder) && !code.includes(manifestPlaceholder))) return null;
      return {
        code: code
          .replaceAll(placeholder, manifest.hash)
          .replaceAll(manifestPlaceholder, JSON.stringify(manifest)),
        map: null,
      };
    },
    generateBundle() {
      if (!manifest || options.emit === false) return;
      this.emitFile({
        type: "asset",
        fileName: options.fileName ?? CONTRACT_FILE,
        source: canonicalManifestJson(manifest),
      });
    },
  };
}
