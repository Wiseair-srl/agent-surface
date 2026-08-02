#!/usr/bin/env node
/**
 * Gate 3 — version lockstep.
 *
 * Every published package ships on one version. That is not cosmetic here:
 * internal dependencies are `workspace:^`, which publishes as a caret, and a
 * caret on a `0.x` version pins the MINOR — `^0.20.1` means `>=0.20.1 <0.21.0`.
 * So the moment one package moves alone, its siblings' ranges stop accepting it
 * and a consumer installing two of them resolves two copies of `@agent-surface/core`.
 * Two copies is not merely weight: authority identity lives in module-level
 * WeakMaps, so a capability minted by one copy is rejected by the other
 * (see packages/core/src/contract.ts).
 *
 * The failure is silent by construction — `changeset version` bumps exactly the
 * packages a changeset names, and naming only the package you edited is the
 * natural thing to do. It has split this repository five times.
 *
 * Source-level and offline: it reads the working tree, so it fails on the
 * "Version Packages" PR that would create the split, before anything ships.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const published = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const manifestPath = join(packagesDir, entry.name, "package.json");
    try {
      return { dir: entry.name, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
    } catch {
      return undefined;
    }
  })
  .filter((entry) => entry !== undefined && !entry.manifest.private)
  .map((entry) => ({ dir: entry.dir, name: entry.manifest.name, version: entry.manifest.version }));

if (published.length === 0) {
  console.error("version lockstep: found no published package to check");
  process.exit(1);
}

/** Numeric compare of `major.minor.patch`. This repository ships no prereleases. */
function compare(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// The line is the HIGHEST version, never the most common one. Repair only ever
// runs one way — a published version cannot be recalled, so the laggards come
// up to meet it — and naming the majority as the line would print exactly the
// wrong instruction on the usual split, where one package moved and six did not.
const line = published.map((entry) => entry.version).sort(compare).at(-1);
const stragglers = published.filter((entry) => entry.version !== line);

if (stragglers.length > 0) {
  console.error(
    `version lockstep: ${stragglers.length} package(s) are off the ${line} line\n`,
  );
  for (const entry of stragglers) console.error(`  ✗ ${entry.name} is ${entry.version}, behind ${line}`);
  console.error(
    "\nA release changeset is a lockstep declaration, not a description of the diff:" +
      `\nname all ${published.length} packages in it, even when only one package changed.` +
      `\n\nTo repair: raise the versions above to ${line} by hand, then let one grouped` +
      `\nchangeset naming all ${published.length} carry them to the next number. The laggards skip a` +
      "\nnumber on npm, which is harmless — say so in the changeset.",
  );
  process.exit(1);
}

console.log(`version lockstep: ${published.length} published package(s) on ${line}`);
