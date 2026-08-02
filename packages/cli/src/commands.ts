import { resolve } from "node:path";
import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";
import {
  compileCapabilityContract,
  computeManifestHash,
  type ExternalContractPolicy,
} from "@agent-surface/compiler";
import { diffContracts, type ChangeClassification } from "./diff.js";
import { DEFAULT_SNAPSHOT, readBaseManifest, readManifest, writeManifest } from "./files.js";
import type { ContractReport, OutputFormat, RenderOptions, Verbosity } from "./report.js";
import { renderReport, supportsColor } from "./report.js";

export interface CommandOptions {
  root: string;
  configFile?: string;
  snapshot?: string;
  targets: string[];
  base?: string;
  format: OutputFormat;
  policy: "all" | ChangeClassification | "none";
  /** Dependencies approved to contribute, as `--allow <package>=<sha256>`. */
  externalContracts?: ExternalContractPolicy;
  plain?: boolean;
  /** Deprecated alias for `verbosity: "detail"`. */
  detail?: boolean;
  verbosity?: Verbosity;
}

function mergeManifests(manifests: CapabilityContractManifest[]): CapabilityContractManifest {
  const entries = new Map<string, CapabilityContractEntry>();
  for (const manifest of manifests) {
    for (const entry of manifest.capabilities) {
      const key = `${entry.declarationId}\0${entry.capabilityId}`;
      const existing = entries.get(key);
      if (!existing) entries.set(key, { ...entry, targets: [...entry.targets] });
      else {
        if (existing.contractHash !== entry.contractHash) {
          throw new Error(`contract ${entry.declarationId} / ${entry.capabilityId} differs across targets`);
        }
        existing.targets = [...new Set([...existing.targets, ...entry.targets])].sort();
      }
    }
  }
  const payload = {
    formatVersion: 5 as const,
    compilerVersion: manifests[0]?.compilerVersion ?? "unknown",
    targets: [...new Set(manifests.flatMap((manifest) => manifest.targets))].sort(),
    capabilities: [...entries.values()].sort((a, b) =>
      `${a.declarationId}\0${a.capabilityId}`.localeCompare(`${b.declarationId}\0${b.capabilityId}`),
    ),
    // One attribution per package: the same dependency contributes identically
    // to every target, and a divergence would already have failed the compile.
    externalContracts: manifests
      .flatMap((manifest) => manifest.externalContracts)
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.package === entry.package) === index)
      .sort((a, b) => a.package.localeCompare(b.package)),
    completeness: { status: "proven" as const },
  };
  return { ...payload, hash: computeManifestHash(payload) };
}

async function compile(options: CommandOptions): Promise<CapabilityContractManifest> {
  const targets = options.targets.length > 0 ? options.targets : ["web-production"];
  const manifests = await Promise.all(
    targets.map((target) =>
      compileCapabilityContract({
        root: options.root,
        ...(options.configFile ? { configFile: options.configFile } : {}),
        ...(options.externalContracts ? { externalContracts: options.externalContracts } : {}),
        target,
      }),
    ),
  );
  return mergeManifests(manifests);
}

function shouldFail(
  policy: CommandOptions["policy"],
  changes: ReturnType<typeof diffContracts>,
): boolean {
  if (policy === "none") return false;
  if (policy === "all") return changes.length > 0;
  return changes.some((change) => change.classification === policy);
}

async function present(report: ContractReport, options: CommandOptions): Promise<void> {
  const interactive =
    options.format === "human" &&
    !options.plain &&
    process.stdout.isTTY === true &&
    !process.env["CI"] &&
    !process.env["NO_COLOR"];
  const verbosity = options.verbosity ?? (options.detail ? "detail" : "normal");
  const render: RenderOptions = { root: options.root, verbosity };
  if (interactive) {
    const { renderInk } = await import("./ink.js");
    await renderInk(report, render);
    return;
  }
  // `--plain` at a terminal still paints; a pipe, CI, or NO_COLOR never does.
  process.stdout.write(
    renderReport(report, options.format, { ...render, color: supportsColor(process.stdout) }),
  );
}

export async function runInspect(options: CommandOptions): Promise<number> {
  const manifest = await compile(options);
  const snapshotPath = resolve(options.root, options.snapshot ?? DEFAULT_SNAPSHOT);
  const snapshot = readManifest(snapshotPath);
  const integrityChanges = diffContracts(snapshot, manifest);
  const report: ContractReport = {
    command: "inspect",
    status: "view",
    manifest,
    snapshotPath,
    integrity: {
      status: !snapshot ? "missing" : snapshot.hash === manifest.hash ? "current" : "stale",
      changes: integrityChanges,
    },
    ...(options.base
      ? {
          pullRequest: {
            base: options.base,
            changes: diffContracts(readBaseManifest(options.base, snapshotPath, options.root), manifest),
          },
        }
      : {}),
  };
  await present(report, options);
  return 0;
}

export async function runSnapshot(options: CommandOptions): Promise<number> {
  const manifest = await compile(options);
  const snapshotPath = resolve(options.root, options.snapshot ?? DEFAULT_SNAPSHOT);
  writeManifest(snapshotPath, manifest);
  await present({ command: "snapshot", status: "written", manifest, snapshotPath }, options);
  return 0;
}

export async function runCheck(options: CommandOptions): Promise<number> {
  const manifest = await compile(options);
  const snapshotPath = resolve(options.root, options.snapshot ?? DEFAULT_SNAPSHOT);
  const snapshot = readManifest(snapshotPath);
  const integrityChanges = diffContracts(snapshot, manifest);
  const integrityCurrent = snapshot?.hash === manifest.hash;
  const pr = options.base
    ? {
        base: options.base,
        changes: diffContracts(readBaseManifest(options.base, snapshotPath, options.root), snapshot ?? manifest),
      }
    : undefined;
  const failed = !integrityCurrent || (pr ? shouldFail(options.policy, pr.changes) : false);
  const report: ContractReport = {
    command: "check",
    status: failed ? "fail" : "pass",
    manifest,
    snapshotPath,
    integrity: {
      status: !snapshot ? "missing" : integrityCurrent ? "current" : "stale",
      changes: integrityChanges,
    },
    ...(pr ? { pullRequest: pr } : {}),
  };
  await present(report, options);
  // stderr, like the report hint in orpc-agent: it survives a piped report.
  if (failed && !integrityCurrent && options.format === "human") {
    process.stderr.write("\nUpdate the snapshot in this change: agent-surface snapshot\n");
  }
  return failed ? 1 : 0;
}
