import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { CapabilityContractManifest } from "@agent-surface/core";
import { canonicalManifestJson, verifyManifest } from "@agent-surface/compiler";

export const DEFAULT_SNAPSHOT = ".agent-surface/contract.json";

export function readManifest(path: string): CapabilityContractManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as CapabilityContractManifest;
    verifyManifest(manifest);
    return manifest;
  } catch (error) {
    throw new Error(`could not read contract ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeManifest(path: string, manifest: CapabilityContractManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalManifestJson(manifest), "utf8");
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function readBaseManifest(
  base: string,
  snapshotPath: string,
  cwd: string,
): CapabilityContractManifest {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const absolute = isAbsolute(snapshotPath) ? snapshotPath : resolve(cwd, snapshotPath);
  const path = relative(root, absolute);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`snapshot ${snapshotPath} is outside the Git worktree`);
  }
  const text = git(["show", `${base}:${path.split(sep).join("/")}`], root);
  try {
    const manifest = JSON.parse(text) as CapabilityContractManifest;
    verifyManifest(manifest);
    return manifest;
  } catch (error) {
    throw new Error(`could not read ${snapshotPath} at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
