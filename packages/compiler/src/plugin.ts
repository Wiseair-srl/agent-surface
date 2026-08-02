import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_LIMITS,
  parseCapabilityId,
  validateJsonSchemaDocument,
} from "@agent-surface/core";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import type { Plugin } from "vite";
import { canonicalJson, canonicalManifestJson, computeManifestHash, sha256, verifyManifest } from "./canonical.js";
import { extractModule } from "./extract.js";

export const COMPILER_VERSION = "0.17.0";
export const CONTRACT_FILE = "agent-surface.contract.json";
export const VIRTUAL_CONTRACT_ID = "virtual:agent-surface-contract";
const RESOLVED_VIRTUAL_CONTRACT_ID = `\0${VIRTUAL_CONTRACT_ID}`;

/**
 * One dependency the consumer has approved as a capability contributor.
 *
 * Keyed by package name rather than path: a path is a property of the installer
 * (pnpm store layout, hoisting, workspace links), while the name is what a
 * reviewer actually approves.
 */
export interface ExternalContractAllowEntry {
  /** npm package name, exactly as in its package.json. */
  package: string;
  /** sha256 of that package's contribution, as reported by a failing build. */
  digest: string;
  /**
   * Explicit sidecar path, for a contract that is not reachable from the
   * production module graph. Auto-discovered sidecars need no path.
   */
  path?: string;
}

export interface ExternalContractPolicy {
  /**
   * Dependencies allowed to contribute capabilities. A contribution from a
   * package absent here fails the build: discovery is not authorization.
   */
  allow?: ExternalContractAllowEntry[];
}

export interface AgentSurfaceCompilerOptions {
  target?: string;
  emit?: boolean;
  fileName?: string;
  externalContracts?: ExternalContractPolicy;
  onManifest?: (manifest: CapabilityContractManifest) => void;
}

/** A dependency's capabilities plus how they were found, before authorization. */
interface ExternalContribution {
  package: string;
  source: string;
  route: "sidecar" | "source";
  contractDigest: string;
  entries: CapabilityContractEntry[];
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

interface NearestPackage {
  name: string;
  dir: string;
  packagePath: string;
  sidecar?: string;
}

/** The package.json governing a module id, with its declared sidecar if any. */
function nearestPackage(id: string): NearestPackage | undefined {
  if (id.startsWith("\0") || !isAbsolute(id)) return undefined;
  let dir = dirname(id.split("?")[0]!);
  while (dir !== dirname(dir)) {
    const packagePath = join(dir, "package.json");
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        name?: string;
        agentSurface?: { contract?: string };
      };
      if (!pkg.name) return undefined;
      return {
        name: pkg.name,
        dir,
        packagePath,
        ...(pkg.agentSurface?.contract ? { sidecar: resolve(dir, pkg.agentSurface.contract) } : {}),
      };
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * A module is first-party when it is not installed as a dependency. Vite
 * resolves to real paths, so a workspace package symlinked into node_modules
 * reads as first-party — which is correct: the authority describes one
 * deployable build, and its own workspace is part of it.
 */
function isDependencyModule(id: string): boolean {
  return id.split("?")[0]!.includes(`${sep}node_modules${sep}`);
}

function readSidecar(path: string): { manifest: CapabilityContractManifest; digest: string } {
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes.toString("utf8")) as CapabilityContractManifest;
  verifyManifest(manifest);
  return { manifest, digest: sha256(bytes) };
}

/**
 * Match each contribution against the consumer's allow list.
 *
 * Discovery is deliberately not authorization: an unapproved dependency is
 * reported with the digest to approve, so the fix is a reviewable one-line
 * addition rather than a flag that turns the check off.
 */
function authorizeContributions(
  contributions: readonly ExternalContribution[],
  policy: ExternalContractPolicy | undefined,
): CapabilityContractManifest["externalContracts"] {
  const allow = new Map((policy?.allow ?? []).map((entry) => [entry.package, entry]));
  const unauthorized: string[] = [];
  const mismatched: string[] = [];
  const attributions: CapabilityContractManifest["externalContracts"] = [];

  for (const contribution of contributions) {
    const approved = allow.get(contribution.package);
    if (!approved) {
      unauthorized.push(
        `  ${contribution.package} (${contribution.route}: ${contribution.source})\n` +
          `    { "package": "${contribution.package}", "digest": "${contribution.contractDigest}" }`,
      );
      continue;
    }
    if (approved.digest !== contribution.contractDigest) {
      mismatched.push(
        `  ${contribution.package}: approved ${approved.digest}, this build computed ${contribution.contractDigest}`,
      );
      continue;
    }
    attributions.push({
      package: contribution.package,
      source: contribution.source,
      route: contribution.route,
      contractDigest: contribution.contractDigest,
      authorization: { mode: "pinned", expectedDigest: approved.digest },
    });
  }

  if (unauthorized.length > 0) {
    throw new Error(
      `unauthorized external capability contract(s). A dependency cannot contribute capabilities ` +
        `until the consumer approves it. Add to externalContracts.allow:\n${unauthorized.join("\n")}`,
    );
  }
  if (mismatched.length > 0) {
    throw new Error(
      `external capability contract digest mismatch. The dependency changed what it contributes; ` +
        `review the change before updating the approved digest:\n${mismatched.join("\n")}`,
    );
  }
  return attributions.sort((a, b) => a.package.localeCompare(b.package));
}

export function agentSurface(options: AgentSurfaceCompilerOptions = {}): Plugin {
  const target = options.target ?? "web-production";
  const placeholder = `__AGENT_SURFACE_MANIFEST_HASH_${Math.random().toString(36).slice(2)}__`;
  const manifestPlaceholder = `__AGENT_SURFACE_MANIFEST_${Math.random().toString(36).slice(2)}__`;
  let root = process.cwd();
  let entries: CapabilityContractEntry[] = [];
  /** Capabilities extracted from a dependency's own source, by package. */
  let sourceEntries = new Map<string, CapabilityContractEntry[]>();
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
      return `import { createCapabilityAuthority } from "@agent-surface/core";
const manifest = ${manifestPlaceholder};
export { manifest };
export default createCapabilityAuthority(manifest);`;
    },
    buildStart() {
      entries = [];
      sourceEntries = new Map();
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
      // A dependency that calls a contract macro in its own source contributes
      // capabilities with no sidecar and no file to digest. Attribute them to
      // the owning package now, so buildEnd can put them through the same
      // authorization as a sidecar instead of admitting them silently.
      const owner = isDependencyModule(id) ? nearestPackage(id) : undefined;
      if (owner) {
        const existing = sourceEntries.get(owner.name) ?? [];
        existing.push(...extracted.entries);
        sourceEntries.set(owner.name, existing);
      } else {
        entries.push(...extracted.entries);
      }
      return extracted.code === code ? null : { code: extracted.code, map: null };
    },
    buildEnd(error) {
      if (error) return;
      const contributions: ExternalContribution[] = [];
      const seenSidecars = new Set<string>();

      // Sidecars declared by packages reachable from the production graph.
      for (const id of this.getModuleIds()) {
        if (!isDependencyModule(id)) continue;
        const owner = nearestPackage(id);
        if (!owner?.sidecar || seenSidecars.has(owner.sidecar)) continue;
        seenSidecars.add(owner.sidecar);
        const { manifest: external, digest } = readSidecar(owner.sidecar);
        contributions.push({
          package: owner.name,
          source: relative(root, owner.sidecar).split(sep).join("/"),
          route: "sidecar",
          contractDigest: digest,
          entries: external.capabilities,
        });
      }

      // Sidecars named explicitly, for contracts outside the module graph.
      for (const allowed of options.externalContracts?.allow ?? []) {
        if (!allowed.path) continue;
        const path = isAbsolute(allowed.path) ? allowed.path : resolve(root, allowed.path);
        if (seenSidecars.has(path)) continue;
        seenSidecars.add(path);
        // The package name comes from where the file lives, not from the entry
        // that approves it — otherwise a path-pinned contract would always
        // authorize itself under whatever name the consumer happened to write.
        const owner = nearestPackage(path);
        if (owner && owner.name !== allowed.package) {
          throw new Error(
            `external contract "${allowed.path}" belongs to "${owner.name}", not the approved "${allowed.package}"`,
          );
        }
        const { manifest: external, digest } = readSidecar(path);
        contributions.push({
          package: owner?.name ?? allowed.package,
          source: allowed.path,
          route: "sidecar",
          contractDigest: digest,
          entries: external.capabilities,
        });
      }

      // Contract macros in a dependency's own source: no file to digest, so the
      // digest covers the canonical set of entries it actually contributed.
      for (const [name, extracted] of [...sourceEntries].sort(([a], [b]) => a.localeCompare(b))) {
        if (extracted.length === 0) continue;
        const sorted = mergeEntries(extracted);
        contributions.push({
          package: name,
          source: sorted[0]?.origin ?? name,
          route: "source",
          contractDigest: sha256(canonicalJson(sorted)),
          entries: sorted,
        });
      }

      const externalContracts = authorizeContributions(contributions, options.externalContracts);
      const externalEntries = contributions.flatMap((contribution) => contribution.entries);
      const capabilities = mergeEntries([...entries, ...externalEntries]);
      validateEntries(capabilities);
      const targets = [...new Set(capabilities.flatMap((entry) => entry.targets))].sort();
      const payload = {
        formatVersion: 5 as const,
        compilerVersion: COMPILER_VERSION,
        targets,
        capabilities,
        externalContracts,
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
