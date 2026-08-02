import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_LIMITS,
  parseCapabilityId,
  validateJsonSchemaDocument,
} from "@agent-surface/core";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import type { Plugin, ResolvedConfig } from "vite";
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

/**
 * Compiled contracts for serve runs, keyed by root and target.
 *
 * The compile is a full production build, so it is memoised: a vitest run with
 * several environments would otherwise pay for it once per environment. Cleared
 * when a module that declares a contract changes, so the dev server does not
 * serve yesterday's ceiling.
 */
const serveManifests = new Map<string, Promise<CapabilityContractManifest>>();

function compileServeManifest(options: {
  root: string;
  target: string;
  externalContracts?: ExternalContractPolicy;
  /**
   * The serving config's own resolution, forwarded so the inner build resolves
   * imports exactly as the outer one does. Without it a project that aliases
   * inline rather than in a config file — every vitest setup that maps a
   * workspace package, for one — compiles against different modules than it
   * serves, or fails to resolve them at all.
   */
  alias: ResolvedConfig["resolve"]["alias"] | undefined;
  configFile: string | false | undefined;
}): Promise<CapabilityContractManifest> {
  const key = `${options.root}\0${options.target}`;
  const cached = serveManifests.get(key);
  if (cached) return cached;
  // Imported lazily: compile.ts imports this module, and only one of the two
  // edges may be static.
  const pending = import("./compile.js").then(({ compileCapabilityContract }) =>
    compileCapabilityContract({
      root: options.root,
      target: options.target,
      ...(options.externalContracts ? { externalContracts: options.externalContracts } : {}),
      vite: {
        ...(options.configFile === false ? { configFile: false as const } : {}),
        ...(options.alias ? { resolve: { alias: options.alias } } : {}),
      },
    }),
  );
  serveManifests.set(key, pending);
  // A failed compile must not be cached, or the first broken contract poisons
  // the dev server until it is restarted.
  void pending.catch(() => serveManifests.delete(key));
  return pending;
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
  /** True under the dev server and the test runner; false in a production build. */
  let serve = false;
  let serveAlias: ResolvedConfig["resolve"]["alias"] | undefined;
  let serveConfigFile: string | false | undefined;

  /** The eagerly-compiled manifest, or a clear failure. Serve mode only. */
  const servedManifest = (): CapabilityContractManifest => {
    if (!manifest) throw new Error("agent-surface: contract not compiled for this dev/test run");
    return manifest;
  };

  /**
   * What a contract's proof must carry as its manifest hash.
   *
   * In a build that is the placeholder, rewritten once the manifest exists. In
   * serve the real hash is already known, and stamping it here is what lets a
   * registration pass `assertDefinitionAuthorized` outside a build.
   */
  const manifestHashToken = (): string => (serve ? servedManifest().hash : placeholder);

  return {
    name: "agent-surface:compiler",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      // `serve` covers the dev server AND vitest, which drives the same
      // pipeline. Rollup's output hooks (renderChunk, generateBundle) never run
      // there, so the placeholders they rewrite have to be resolved up front —
      // see `buildStart` below.
      serve = config.command === "serve";
      serveAlias = config.resolve?.alias;
      serveConfigFile = config.configFile === undefined ? false : config.configFile;
    },
    resolveId(id) {
      return id === VIRTUAL_CONTRACT_ID ? RESOLVED_VIRTUAL_CONTRACT_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_CONTRACT_ID) return null;
      // In a build the manifest is not known until every module has been
      // transformed, so the placeholder stands in and `renderChunk` rewrites
      // it. Under serve it is already computed and can be inlined.
      const inlined = serve ? JSON.stringify(servedManifest()) : manifestPlaceholder;
      return `import { createCapabilityAuthority } from "@agent-surface/core";
const manifest = ${inlined};
export { manifest };
export default createCapabilityAuthority(manifest);`;
    },
    async buildStart() {
      entries = [];
      sourceEntries = new Map();
      manifest = undefined;
      if (!serve) return;
      // Serve mode compiles the contract eagerly, through the same production
      // build the CLI uses, because a lazily-transformed module graph cannot
      // tell us the manifest hash that every contract's proof has to carry.
      // Without this the dev server and the test runner would have no
      // authority at all, and every registration would be refused.
      manifest = await compileServeManifest({
        root,
        target,
        alias: serveAlias,
        configFile: serveConfigFile,
        ...(options.externalContracts ? { externalContracts: options.externalContracts } : {}),
      });
    },
    transform(code, id) {
      if (
        id.includes("/node_modules/@agent-surface/") ||
        /\/packages\/(?:core|react|orpc|testing|webmcp|cli|compiler)\//.test(id) ||
        // Vite's optimized-dependency chunks, which exist only under serve.
        // They are bundled OUTPUT — several dependencies concatenated, this
        // package among them — so the guards below would read our own
        // `registry.register({` back out of a vendor chunk and refuse to serve
        // the app. A dependency's real contracts are picked up from its actual
        // module, via the sidecar and source routes, not from optimizer output.
        id.includes("/node_modules/.vite/")
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
      const extracted = extractModule({ code, id, root, target, placeholder: manifestHashToken() });
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
      // Serve already has its manifest, compiled from the whole graph in
      // `buildStart`. Recomputing it here would derive it from whatever modules
      // the dev server happened to request, which is a subset — and a contract
      // narrower than the truth silently refuses real capabilities.
      if (error || serve) return;
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
    async handleHotUpdate(ctx) {
      if (!serve) return;
      const code = await ctx.read();
      if (
        !code.includes("defineAgentComponentContract") &&
        !code.includes("defineAgentProcedureContract") &&
        !code.includes("defineExternalAgentToolContract")
      ) {
        return;
      }
      // Editing a contract changes the manifest hash, which every already-loaded
      // proof is pinned to. Patching one module would leave the rest stale and
      // registering against a hash nothing else agrees with, so the whole page
      // goes back for a fresh authority.
      serveManifests.delete(`${root}\0${target}`);
      manifest = await compileServeManifest({
        root,
        target,
        alias: serveAlias,
        configFile: serveConfigFile,
        ...(options.externalContracts ? { externalContracts: options.externalContracts } : {}),
      });
      const virtual = ctx.server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_CONTRACT_ID);
      if (virtual) ctx.server.moduleGraph.invalidateModule(virtual);
      ctx.server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}
