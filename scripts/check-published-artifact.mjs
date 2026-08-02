#!/usr/bin/env node
/**
 * Gate 2 — published artifact closure.
 *
 * Runs `npm pack` for every published package, unpacks the real tarball and
 * inspects what npm would ship. This catches packaging regressions that no
 * source-level check can see: a widened exports map, a leaked declaration,
 * or the repository-only authority seam surviving into dist.
 *
 * Run after "pnpm build".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectPackedPackage } from "./lib/published-artifact.mjs";
import { publishedEntries } from "./lib/api-closure.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [...new Set(publishedEntries(root).map((entry) => entry.package))];
const problems = [];
const workspace = mkdtempSync(join(tmpdir(), "agent-surface-pack-"));

try {
  for (const name of packages) {
    const dir = join(root, "packages", name.replace("@agent-surface/", ""));
    const out = mkdtempSync(join(workspace, "pkg-"));
    execFileSync("npm", ["pack", "--pack-destination", out, "--silent"], { cwd: dir, stdio: "pipe" });
    const tarball = readdirSync(out).find((entry) => entry.endsWith(".tgz"));
    if (!tarball) {
      problems.push(`${name}: npm pack produced no tarball`);
      continue;
    }
    execFileSync("tar", ["-xzf", join(out, tarball), "-C", out], { stdio: "pipe" });
    problems.push(...inspectPackedPackage(join(out, "package")));
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`published artifact closure: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`published artifact closure: ${packages.length} package(s) ship no unsafe seam`);
