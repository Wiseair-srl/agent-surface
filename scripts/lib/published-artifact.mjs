/**
 * Published artifact closure (AS-ARTIFACT-001…003).
 *
 * Source-level guarantees say nothing about what npm actually ships. These
 * checks read a packed package directory — the tarball contents, not the
 * working tree — and assert that the repository-only authority seam is
 * neither importable, nor typed, nor present at all.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Identifiers that must never reach a published artifact. */
export const FORBIDDEN_SEAM_SYMBOLS = [
  "enableUnsafeAuthorityTestMode",
  "disableUnsafeAuthorityTestMode",
];

/** Identifiers that may exist internally but must never be exported. */
export const INTERNAL_ONLY_SYMBOLS = ["isUnsafeAuthorityTestMode"];

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * The files npm would ship. Honouring `files` matters in both directions: on a
 * working tree it keeps `src`, `test` and `node_modules` out of the result, and
 * on an unpacked tarball it is already the whole content, so the same function
 * gives the same answer either way.
 */
function* shippedFiles(packageDir, pkg) {
  const roots = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ["."];
  for (const root of roots) {
    const path = join(packageDir, root);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Names an ES module re-exports, as written by the bundler. */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const clause of match[1].split(",")) {
      const parts = clause.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0] ?? "").trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Inspect one packed package directory (the `package/` root of a tarball).
 * Returns human-readable problems; empty means the artifact is closed.
 */
export function inspectPackedPackage(packageDir) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const label = pkg.name;

  /* AS-ARTIFACT-001 — no wildcard subpath can widen the import surface. */
  const exportKeys = Object.keys(pkg.exports ?? {});
  if (exportKeys.length === 0) {
    problems.push(`${label}: publishes no exports map, so every internal file is importable`);
  }
  for (const key of exportKeys) {
    if (key.includes("*")) {
      problems.push(`${label}: exports map subpath "${key}" is a wildcard and can expose internal modules`);
    }
  }
  const declared = new Set(
    Object.values(pkg.exports ?? {})
      .flatMap((condition) => (typeof condition === "object" ? Object.values(condition) : [condition]))
      .filter((value) => typeof value === "string"),
  );
  for (const fallback of ["main", "module", "types"]) {
    const value = pkg[fallback];
    if (value && !declared.has(value)) {
      problems.push(`${label}: "${fallback}" points at ${value}, which no exports subpath declares`);
    }
  }

  /* AS-ARTIFACT-002/003 — the seam itself. */
  for (const path of shippedFiles(packageDir, pkg)) {
    if (!/\.(js|mjs|cjs|d\.ts|d\.mts)$/.test(path)) continue;
    const rel = relative(packageDir, path);
    const source = readFileSync(path, "utf8");

    for (const symbol of FORBIDDEN_SEAM_SYMBOLS) {
      if (source.includes(symbol)) {
        problems.push(`${label}: ${rel} contains the repository-only seam "${symbol}"`);
      }
    }
    if (/\.d\.[cm]?ts$/.test(path)) {
      for (const symbol of INTERNAL_ONLY_SYMBOLS) {
        if (source.includes(symbol)) {
          problems.push(`${label}: declaration file ${rel} types the internal symbol "${symbol}"`);
        }
      }
      continue;
    }
    const exported = exportedNames(source);
    for (const symbol of INTERNAL_ONLY_SYMBOLS) {
      if (exported.has(symbol)) {
        problems.push(`${label}: ${rel} exports the internal symbol "${symbol}"`);
      }
    }
  }
  return problems;
}
